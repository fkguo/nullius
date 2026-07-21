import { existsSync } from 'fs';
import { payloadHash as artifactPayloadHash } from '../hash/payload-hash.js';
import { IdeaEngineStore, NodeLogCorruptionError } from '../store/engine-store.js';
import { budgetSnapshot } from './budget-snapshot.js';
import { RpcError } from './errors.js';
import { IMPORT_GENERATED_METHOD, recoverImportGenerated } from './import-generated-recovery.js';
import { nodeLifecycleState } from './node-shared.js';

interface IdempotencyResponse {
  kind: 'error' | 'result';
  payload: Record<string, unknown>;
}

interface IdempotencyRecord {
  created_at: string;
  payload_hash: string;
  response: IdempotencyResponse;
  state: 'committed' | 'prepared';
}

function scopeCampaignId(method: string, campaignId: string | null): string | null {
  return method === 'campaign.init' ? null : campaignId;
}

function idempotencyKey(method: string, key: string): string {
  return `${method}:${key}`;
}

function artifactExists(store: IdeaEngineStore, artifactRef: unknown): boolean {
  if (typeof artifactRef !== 'string') {
    return false;
  }
  try {
    return existsSync(store.artifactPathFromRef(artifactRef));
  } catch {
    return false;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function ideaCardRevisionRecoveryConflict(campaignId: string, nodeId: string, message: string, details: Record<string, unknown> = {}): RpcError {
  return new RpcError(-32603, 'internal_error', {
    reason: 'idea_card_revision_recovery_conflict',
    campaign_id: campaignId,
    node_id: nodeId,
    details: { message, ...details },
  });
}

/**
 * Complete a prepared node.revise_card operation without regenerating any
 * scientific content. The prepared response embeds the exact resulting node
 * and append-only event. Recovery always completes those exact prepared bytes;
 * it never discards a durable intent and regenerates timestamps or content.
 */
function recoverIdeaCardRevision(store: IdeaEngineStore, record: IdempotencyRecord): boolean {
  if (record.response.kind !== 'result') {
    return true;
  }
  const payload = record.response.payload;
  const event = asRecord(payload.mutation_event);
  const expectedNode = asRecord(payload.node);
  const beforeNode = asRecord(event?.before_node);
  const eventNode = asRecord(event?.node);
  const topLevelIdempotency = asRecord(payload.idempotency);
  const eventIdempotency = asRecord(event?.idempotency);
  const campaignId = payload.campaign_id;
  const nodeId = expectedNode?.node_id;
  const idempotencyKeyValue = topLevelIdempotency?.idempotency_key;
  if (!event || !expectedNode || !beforeNode || !eventNode || !eventIdempotency || typeof campaignId !== 'string' || typeof nodeId !== 'string' || typeof idempotencyKeyValue !== 'string') {
    throw ideaCardRevisionRecoveryConflict(
      typeof campaignId === 'string' ? campaignId : '00000000',
      typeof nodeId === 'string' ? nodeId : '00000000',
      'prepared node.revise_card response is malformed; exact recovery payload is unavailable',
    );
  }

  const targetRevision = Number(expectedNode.revision);
  const expectedRevision = Number(event.expected_revision);
  const beforeHash = event.before_idea_card_hash;
  const afterHash = event.after_idea_card_hash;
  if (
    typeof expectedNode.revision !== 'number' ||
    typeof event.expected_revision !== 'number' ||
    !Number.isInteger(targetRevision) ||
    !Number.isInteger(expectedRevision) ||
    targetRevision !== expectedRevision + 1 ||
    event.revision !== targetRevision ||
    typeof beforeHash !== 'string' ||
    typeof afterHash !== 'string' ||
    topLevelIdempotency?.payload_hash !== record.payload_hash ||
    eventIdempotency.idempotency_key !== idempotencyKeyValue ||
    eventIdempotency.payload_hash !== record.payload_hash ||
    artifactPayloadHash(eventNode) !== artifactPayloadHash(expectedNode) ||
    event.campaign_id !== campaignId ||
    event.node_id !== nodeId ||
    beforeNode.campaign_id !== campaignId ||
    beforeNode.node_id !== nodeId ||
    beforeNode.revision !== expectedRevision ||
    artifactPayloadHash(beforeNode.idea_card ?? null) !== beforeHash ||
    artifactPayloadHash(expectedNode.idea_card ?? null) !== afterHash
  ) {
    throw ideaCardRevisionRecoveryConflict(campaignId, nodeId, 'prepared node.revise_card revisions or canonical hashes are inconsistent', {
      expected_revision: expectedRevision,
      target_revision: targetRevision,
    });
  }

  let logEntries: Array<Record<string, unknown>>;
  try {
    logEntries = store.loadNodeLogEntriesStrict(campaignId);
  } catch (error) {
    if (!(error instanceof NodeLogCorruptionError)) {
      throw error;
    }
    if (error.kind !== 'torn_final') {
      throw ideaCardRevisionRecoveryConflict(campaignId, nodeId, 'append-only node log contains interior corruption; automatic recovery is forbidden', {
        corruption_kind: error.kind,
        line_number: error.lineNumber,
      });
    }
    try {
      store.repairTornFinalNodeLogEntry(campaignId, event);
      logEntries = store.loadNodeLogEntriesStrict(campaignId);
    } catch (repairError) {
      if (repairError instanceof NodeLogCorruptionError) {
        throw ideaCardRevisionRecoveryConflict(campaignId, nodeId, 'torn final node-log fragment does not match the prepared revision event; automatic recovery is forbidden', {
          corruption_kind: repairError.kind,
          line_number: repairError.lineNumber,
        });
      }
      throw repairError;
    }
  }
  const matchingOwnEvents = logEntries.filter((entry) => {
    if (entry.mutation !== 'revise_card' || entry.node_id !== nodeId) {
      return false;
    }
    const entryIdempotency = asRecord(entry.idempotency);
    return entryIdempotency?.idempotency_key === idempotencyKeyValue;
  });
  if (matchingOwnEvents.length > 1) {
    throw ideaCardRevisionRecoveryConflict(campaignId, nodeId, 'append-only log contains duplicate events for one node.revise_card idempotency key', {
      idempotency_key: idempotencyKeyValue,
      event_count: matchingOwnEvents.length,
    });
  }
  if (matchingOwnEvents.length === 1 && artifactPayloadHash(matchingOwnEvents[0]) !== artifactPayloadHash(event)) {
    throw ideaCardRevisionRecoveryConflict(campaignId, nodeId, 'append-only log event conflicts with the exact event stored in the prepared idempotency record', {
      idempotency_key: idempotencyKeyValue,
    });
  }

  const nodes = store.loadNodes<Record<string, unknown>>(campaignId);
  const current = nodes[nodeId];
  if (!current) {
    throw ideaCardRevisionRecoveryConflict(campaignId, nodeId, 'node is missing while recovering a prepared card revision');
  }
  const currentRevision = Number(current.revision);
  const currentCardHash = artifactPayloadHash(current.idea_card ?? null);
  const eventLanded = matchingOwnEvents.length === 1;
  if (eventLanded) {
    // Normal write order is node -> event. Once the exact event exists, later
    // node revisions are legitimate and must not be overwritten during replay.
    if (currentRevision < targetRevision) {
      throw ideaCardRevisionRecoveryConflict(campaignId, nodeId, 'append-only revision event exists but latest node predates its resulting revision', {
        current_revision: currentRevision,
        target_revision: targetRevision,
      });
    }
    if (currentRevision === targetRevision && artifactPayloadHash(current) !== artifactPayloadHash(expectedNode)) {
      throw ideaCardRevisionRecoveryConflict(campaignId, nodeId, 'latest node at the logged target revision conflicts with the prepared result', { current_revision: currentRevision });
    }
    return true;
  }

  // Never append an old event after another event at the same or a later
  // revision. That would make the append-only ledger disagree with revision
  // order even if the latest node happened to retain the same card hash.
  const blockingLaterEvent = logEntries.find((entry) => entry.node_id === nodeId && Number.isInteger(Number(entry.revision)) && Number(entry.revision) >= targetRevision);
  if (blockingLaterEvent) {
    throw ideaCardRevisionRecoveryConflict(campaignId, nodeId, 'a same-node event at the target or a later revision already exists; late insertion of the prepared event is forbidden', {
      target_revision: targetRevision,
      blocking_revision: Number(blockingLaterEvent.revision),
      blocking_mutation: blockingLaterEvent.mutation ?? null,
    });
  }

  if (currentRevision < expectedRevision) {
    throw ideaCardRevisionRecoveryConflict(campaignId, nodeId, 'latest node revision moved backwards relative to the prepared card revision', {
      current_revision: currentRevision,
      expected_revision: expectedRevision,
    });
  }
  if (currentRevision === expectedRevision) {
    if (currentCardHash !== beforeHash || artifactPayloadHash(current) !== artifactPayloadHash(beforeNode)) {
      throw ideaCardRevisionRecoveryConflict(campaignId, nodeId, 'latest node at expected_revision no longer equals the exact prepared before-state', {
        current_revision: currentRevision,
        current_card_hash: currentCardHash,
        before_idea_card_hash: beforeHash,
      });
    }
    nodes[nodeId] = structuredClone(expectedNode);
    store.saveNodes(campaignId, nodes);
    store.appendNodeLogEntry(campaignId, structuredClone(event));
    return true;
  }
  if (currentRevision > targetRevision) {
    throw ideaCardRevisionRecoveryConflict(campaignId, nodeId, 'latest node advanced beyond the prepared revision before its event landed; late insertion is forbidden', {
      current_revision: currentRevision,
      target_revision: targetRevision,
    });
  }
  if (currentRevision !== targetRevision || currentCardHash !== afterHash || artifactPayloadHash(current) !== artifactPayloadHash(expectedNode)) {
    throw ideaCardRevisionRecoveryConflict(campaignId, nodeId, 'latest node at the target revision conflicts with the exact prepared result', {
      current_revision: currentRevision,
      current_card_hash: currentCardHash,
      after_idea_card_hash: afterHash,
    });
  }

  store.appendNodeLogEntry(campaignId, structuredClone(event));
  return true;
}

function migrateLegacyResultArtifactRef(
  store: IdeaEngineStore,
  method: string,
  record: IdempotencyRecord,
): boolean {
  if (record.response.kind !== 'result') {
    return false;
  }
  const field = method === 'rank.compute'
    ? 'ranking_artifact_ref'
    : method === 'node.promote'
      ? 'handoff_artifact_ref'
      : null;
  if (field === null) {
    return false;
  }
  const legacyRef = record.response.payload[field];
  if (typeof legacyRef !== 'string' || !legacyRef.startsWith('file://')) {
    return false;
  }
  try {
    const artifactPath = store.artifactPathFromRef(legacyRef);
    const artifact = store.loadArtifactFromRef<Record<string, unknown>>(legacyRef);
    record.response.payload[field] = store.portableArtifactRef(
      artifactPath,
      artifactPayloadHash(artifact),
    );
    return true;
  } catch {
    return false;
  }
}

export function responseIdempotency(idempotencyKeyValue: string, payloadHash: string): Record<string, unknown> {
  return {
    idempotency_key: idempotencyKeyValue,
    is_replay: false,
    payload_hash: payloadHash,
  };
}

function preparedSideEffectsCommitted(store: IdeaEngineStore, method: string, record: IdempotencyRecord): boolean {
  if (record.response.kind !== 'result') {
    return true;
  }
  if (method === 'campaign.init') {
    const campaignId = record.response.payload.campaign_id;
    return typeof campaignId === 'string' && existsSync(store.campaignManifestPath(campaignId));
  }
  if (
    method === 'campaign.topup'
    || method === 'campaign.pause'
    || method === 'campaign.resume'
    || method === 'campaign.complete'
  ) {
    const campaignStatus = record.response.payload.campaign_status;
    if (!campaignStatus || typeof campaignStatus !== 'object') {
      return false;
    }
    const expected = campaignStatus as Record<string, unknown>;
    const campaignId = expected.campaign_id;
    if (typeof campaignId !== 'string') {
      return false;
    }
    const campaign = store.loadCampaign<Record<string, unknown>>(campaignId);
    if (!campaign || campaign.campaign_id !== campaignId) {
      return false;
    }
    if (campaign.status !== expected.status) {
      return false;
    }
    return JSON.stringify(budgetSnapshot(campaign as { budget: Record<string, number | null>; usage: Record<string, number> }))
      === JSON.stringify(expected.budget_snapshot);
  }
  if (method === 'rank.compute') {
    return artifactExists(store, record.response.payload.ranking_artifact_ref);
  }
  if (method === 'node.promote') {
    return artifactExists(store, record.response.payload.handoff_artifact_ref);
  }
  if (method === IMPORT_GENERATED_METHOD) {
    // Import-specific: the generic delete-prepared-and-re-execute fallback
    // below is only safe when NOTHING landed (a fresh run re-mints node ids).
    // recoverImportGenerated probes all four recorded effect classes,
    // COMPLETES missing ones from the archived pack artifact, returns false
    // only for the zero-effects case, and throws import_recovery_conflict on
    // a value mismatch it cannot complete.
    return recoverImportGenerated(store, record);
  }
  if (method === 'node.revise_card') {
    return recoverIdeaCardRevision(store, record);
  }
  if (method === 'node.set_posterior' || method === 'node.set_lifecycle' || method === 'node.set_grounding_audit') {
    const campaignId = record.response.payload.campaign_id;
    const nodeSummary = record.response.payload.node;
    if (typeof campaignId !== 'string' || !nodeSummary || typeof nodeSummary !== 'object' || Array.isArray(nodeSummary)) {
      return false;
    }
    const summary = nodeSummary as Record<string, unknown>;
    const nodeId = summary.node_id;
    if (typeof nodeId !== 'string' || typeof summary.updated_at !== 'string') {
      return false;
    }
    const nodes = store.loadNodes<Record<string, unknown>>(campaignId);
    const node = nodes[nodeId];
    if (!node) {
      return false;
    }
    // The node revision is a shared monotonic counter that every mutation
    // advances, so `revision >= recorded` gives false positives: a crash
    // before saveNodes, followed by an unrelated mutation reaching the same
    // revision, would replay a posterior/lifecycle side effect that never
    // landed. Confirm instead that the stored node still carries the exact
    // state this operation produced — its unique updated_at stamp plus the
    // recorded side-effect payload — the same value-equality probe the
    // campaign.* branches above use (recorded status/budget vs a counter).
    if (String(node.updated_at ?? '') !== summary.updated_at) {
      return false;
    }
    if (method === 'node.set_posterior') {
      return JSON.stringify(node.posterior ?? null) === JSON.stringify(summary.posterior ?? null)
        && JSON.stringify(node.literature_coverage ?? null) === JSON.stringify(summary.literature_coverage ?? null);
    }
    if (method === 'node.set_grounding_audit') {
      // Same updated_at-gated value-equality probe as its siblings, and the same
      // accepted tradeoff: an intervening mutation moves updated_at, so recovery
      // re-executes rather than replays. For an absolute overwrite that is
      // harmless. The one residual: if a rewrite_provenance nulls this audit
      // between the crash and the retry, re-execution re-applies the pre-rewrite
      // audit. That is report-CONTENT freshness (does the grounding report still
      // cover the current card?), which the engine never gates — the contract
      // assigns report-content verification to project-side audit — so it is not
      // closed here. rewrite_provenance's eager reset covers the common
      // (no-crash) case; this narrow crash-window residual is the same class as
      // set_posterior/set_lifecycle resurrecting an overwritten value on retry.
      return JSON.stringify(node.grounding_audit ?? null) === JSON.stringify(summary.grounding_audit ?? null);
    }
    return nodeLifecycleState(node) === summary.lifecycle_state
      && (node.lifecycle_reason ?? null) === (summary.lifecycle_reason ?? null)
      && JSON.stringify(node.activation_condition ?? null) === JSON.stringify(summary.activation_condition ?? null);
  }
  if (method === 'node.rewrite_provenance') {
    const campaignId = record.response.payload.campaign_id;
    const nodeId = record.response.payload.node_id;
    const idempotency = record.response.payload.idempotency as Record<string, unknown> | undefined;
    const opKey = idempotency?.idempotency_key;
    if (typeof campaignId !== 'string' || typeof nodeId !== 'string' || typeof opKey !== 'string') {
      return false;
    }
    const node = store.loadNodes<Record<string, unknown>>(campaignId)[nodeId];
    if (!node) {
      return false;
    }
    // Unlike set_posterior/set_lifecycle — absolute writes whose re-execution is
    // a harmless overwrite — rewrite_provenance re-execution is NOT idempotent:
    // its rewrite_value_unchanged guard would reject the already-applied value.
    // So the committed effect must be recognized by the history entry this
    // operation appended, NOT by the node's top-level updated_at (a later
    // unrelated mutation moves that stamp, which would wrongly force
    // re-execution into rewrite_value_unchanged). The entry is keyed on the
    // request's idempotency_key: (rewritten_at, new_value) is NOT unique —
    // repeated identical corrections at the same clock tick (an A->B, B->A,
    // A->B oscillation) collide, and matching a sibling entry would replay a
    // rewrite whose store effect never landed. The idempotency_key is unique
    // per operation and survives every intervening mutation's structuredClone.
    const operatorTrace = node.operator_trace as Record<string, unknown> | undefined;
    const inputs = operatorTrace?.inputs as Record<string, unknown> | undefined;
    const history = Array.isArray(inputs?.provenance_rewrites)
      ? inputs.provenance_rewrites as Array<Record<string, unknown>>
      : [];
    return history.some(entry =>
      !!entry && typeof entry === 'object'
      && (entry as Record<string, unknown>).idempotency_key === opKey);
  }
  return false;
}

export function recordOrReplay(options: {
  campaignId: string | null;
  idempotencyKeyValue: string;
  method: string;
  payloadHash: string;
  store: IdeaEngineStore;
}): IdempotencyResponse | null {
  const scopedCampaignId = scopeCampaignId(options.method, options.campaignId);
  const idempotencyStore = options.store.loadIdempotency<Record<string, unknown>>(scopedCampaignId) as unknown as Record<
    string,
    IdempotencyRecord
  >;
  const key = idempotencyKey(options.method, options.idempotencyKeyValue);
  const existing = idempotencyStore[key];
  if (!existing) {
    return null;
  }

  if (existing.payload_hash !== options.payloadHash) {
    const data: Record<string, unknown> = {
      reason: 'idempotency_key_conflict',
      idempotency_key: options.idempotencyKeyValue,
      payload_hash: options.payloadHash,
      details: { stored_payload_hash: existing.payload_hash },
    };
    if (options.campaignId) {
      data.campaign_id = options.campaignId;
    }
    throw new RpcError(-32002, 'schema_validation_failed', data);
  }

  if (existing.state === 'prepared') {
    if (!preparedSideEffectsCommitted(options.store, options.method, existing)) {
      delete idempotencyStore[key];
      options.store.saveIdempotency(scopedCampaignId, idempotencyStore);
      return null;
    }
    existing.state = 'committed';
    idempotencyStore[key] = existing;
    options.store.saveIdempotency(scopedCampaignId, idempotencyStore);
  }

  if (migrateLegacyResultArtifactRef(options.store, options.method, existing)) {
    idempotencyStore[key] = existing;
    options.store.saveIdempotency(scopedCampaignId, idempotencyStore);
  }

  const response = structuredClone(existing.response);
  if (response.kind === 'result' && typeof response.payload.idempotency === 'object' && response.payload.idempotency) {
    (response.payload.idempotency as Record<string, unknown>).is_replay = true;
  }
  return response;
}

export function storeIdempotency(options: {
  campaignId: string | null;
  createdAt: string;
  idempotencyKeyValue: string;
  kind: 'error' | 'result';
  method: string;
  payload: Record<string, unknown>;
  payloadHash: string;
  state?: 'committed' | 'prepared';
  store: IdeaEngineStore;
}): void {
  const scopedCampaignId = scopeCampaignId(options.method, options.campaignId);
  const idempotencyStore = options.store.loadIdempotency<Record<string, unknown>>(scopedCampaignId) as unknown as Record<
    string,
    IdempotencyRecord
  >;
  const key = idempotencyKey(options.method, options.idempotencyKeyValue);
  const state = options.state ?? 'committed';
  if (key in idempotencyStore) {
    const existing = idempotencyStore[key]!;
    if (existing.state === 'prepared' && state === 'committed') {
      existing.state = 'committed';
      existing.response = { kind: options.kind, payload: options.payload };
      idempotencyStore[key] = existing;
      options.store.saveIdempotency(scopedCampaignId, idempotencyStore);
    }
    return;
  }
  idempotencyStore[key] = {
    payload_hash: options.payloadHash,
    created_at: options.createdAt,
    state,
    response: { kind: options.kind, payload: options.payload },
  };
  options.store.saveIdempotency(scopedCampaignId, idempotencyStore);
}
