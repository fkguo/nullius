// # CONTRACT-EXEMPT: CODE-01.1 — pre-existing cross-method replay facade; card-revision recovery is extracted, while this lane retains only the required dispatch and shared error-record persistence change.
import { existsSync, readFileSync } from 'fs';
import { payloadHash as artifactPayloadHash } from '../hash/payload-hash.js';
import { IdeaEngineStore, NodeLogCorruptionError } from '../store/engine-store.js';
import { budgetSnapshot } from './budget-snapshot.js';
import { setCampaignRunningIfBudgetAvailable, type CampaignRecord } from './campaign-state.js';
import { RpcError } from './errors.js';
import { IMPORT_GENERATED_METHOD, recoverImportGenerated } from './import-generated-recovery.js';
import { recoverIdeaCardRevision } from './node-revise-card-recovery.js';
import { nodeLifecycleState } from './node-shared.js';

interface IdempotencyResponse {
  kind: 'error' | 'result';
  payload: Record<string, unknown>;
}

export interface IdempotencyRecord {
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
    const payload = record.response.payload;
    if (!artifactExists(store, payload.ranking_artifact_ref)) {
      return false;
    }
    // Reuse responses (unchanged_since) minted nothing and never touched the
    // campaign: the referenced artifact existing is the whole effect. Legacy
    // records (no store_digest, from before the campaign pointer existed)
    // keep the old artifact-existence semantics.
    if (typeof payload.unchanged_since === 'string' || typeof payload.store_digest !== 'string') {
      return true;
    }
    // Mint responses also advanced usage.steps_used and recorded
    // campaign.last_ranking. A crash between the artifact write and the
    // campaign save would otherwise replay a result whose budget/pointer
    // effects never landed — the ordered completion below lands them
    // (pointer := this record; steps := current + 1, exactly this mint's
    // lost step), at most once (repeat recovery short-circuits on pointer
    // equality).
    const campaignId = payload.campaign_id;
    if (typeof campaignId !== 'string') {
      return false;
    }
    const campaign = store.loadCampaign<Record<string, unknown>>(campaignId);
    if (!campaign) {
      return false;
    }
    const lastRanking = campaign.last_ranking as Record<string, unknown> | undefined;
    if (lastRanking && lastRanking.ranking_artifact_ref === payload.ranking_artifact_ref) {
      return true;
    }
    // A different (or absent) pointer means THIS mint's campaign write never
    // landed: every mint's save sets the pointer to its own artifact, and
    // nothing ever removes it — so had this save landed, either the pointer
    // would still be ours (short-circuit above) or a LATER mint overwrote
    // it. The two cases are ordered by the pointer's generated_at:
    // - pointer strictly newer than this record → superseded; the newer
    //   landed state must not be touched (no rollback, no step write — the
    //   lost-save variant leaves one step uncounted, stated honestly: it
    //   undercounts a generous optional ceiling, never resurrects state);
    // - pointer absent or strictly older → this record is the newest mint
    //   and its save is missing; complete it: the pointer becomes this
    //   record's triple and steps_used advances by EXACTLY ONE over the
    //   current value (this mint's own lost step — the current counter
    //   already includes every other landed consumer, node.promote
    //   included, so recorded absolutes could over- or under-count);
    // - equal second-resolution stamps cannot be ordered → treat as
    //   superseded (no write), the conservative side.
    const pointerGeneratedAt = lastRanking && typeof lastRanking.generated_at === 'string'
      ? lastRanking.generated_at
      : null;
    const recordGeneratedAt = typeof payload.generated_at === 'string' ? payload.generated_at : null;
    // Completion requires a provable direction: the pointer must be ABSENT
    // entirely, or both stamps must exist with this record strictly newer.
    // A pointer that exists but cannot be ordered (no generated_at — not
    // producible through the API, but a hand-edited store could carry one)
    // takes the conservative no-write side like every other tie.
    const recordIsNewest = lastRanking === null || lastRanking === undefined
      ? true
      : (pointerGeneratedAt !== null && recordGeneratedAt !== null && recordGeneratedAt > pointerGeneratedAt);
    if (!recordIsNewest) {
      return true;
    }
    const usage = campaign.usage as Record<string, unknown>;
    usage.steps_used = Number(usage.steps_used ?? 0) + 1;
    campaign.last_ranking = {
      store_digest: payload.store_digest,
      ranking_artifact_ref: payload.ranking_artifact_ref,
      generated_at: payload.generated_at,
    };
    // Status is re-derived only from `running`: the original mint could only
    // ever run there, so completion may flip running → exhausted (the step
    // it lands can exhaust the budget) but must never resurrect a paused,
    // early-stopped, or completed campaign on a duplicate request.
    if (campaign.status === 'running') {
      setCampaignRunningIfBudgetAvailable(campaign as CampaignRecord);
    }
    store.saveCampaign(campaign as Record<string, unknown> & { campaign_id: string });
    return true;
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
  if (method === 'node.apply_evidence_event') {
    // saveNodes is one atomic file write: either every disposition's node
    // state landed or none did. The production clock has ONE-SECOND
    // resolution, so a row match alone is NOT proof this event landed — a
    // same-second twin event can produce identical node state. The probe
    // therefore cross-checks two surfaces before certifying on rows alone:
    // ledger lines of OTHER events covering our nodes at the recorded
    // timestamp, and OTHER apply_evidence_event idempotency records whose
    // rows cover our nodes at that timestamp (a twin's prepared record
    // exists BEFORE its node write by construction, so the twin case is
    // decidable even when its ledger lines are lost). Ambiguity fails loud
    // (evidence_event_recovery_conflict) instead of certifying and
    // ledgering an event that may never have landed. When our own ledger
    // lines prove landing, recovery COMPLETES the missing event-group lines
    // (the engine-recorded binding is this method's purpose — rescue it,
    // do not merely detect the gap) and replays the recorded result.
    // Residual, stated honestly: a twin whose idempotency record was
    // externally deleted AND whose ledger lines were all lost is
    // indistinguishable; and if the crash lost every ledger line AND every
    // affected node was mutated again before the retry, the probe reads
    // "nothing landed" and re-executes (the demote edges then refuse and
    // the retry records that refusal) — the same narrow class the
    // single-node value-equality probes above accept.
    const payload = record.response.payload;
    const campaignId = payload.campaign_id;
    const rows = Array.isArray(payload.nodes) ? payload.nodes as Array<Record<string, unknown>> : null;
    const eventGroup = payload.event_group;
    if (typeof campaignId !== 'string' || !rows || rows.length === 0 || typeof eventGroup !== 'string') {
      return false;
    }
    const nodes = store.loadNodes<Record<string, unknown>>(campaignId);
    const rowByNodeId = new Map<string, Record<string, unknown>>(
      rows.map(row => [String(row.node_id), row]),
    );
    const rowMatchesStore = (row: Record<string, unknown>): boolean => {
      const node = nodes[String(row.node_id)];
      if (!node) {
        return false;
      }
      if (
        String(node.updated_at ?? '') !== row.updated_at
        || nodeLifecycleState(node) !== row.lifecycle_state
        || Number(node.revision) !== Number(row.revision)
        || (node.lifecycle_reason ?? null) !== (row.lifecycle_reason ?? null)
      ) {
        return false;
      }
      // Witness the COMPLETE written state: rows recorded before this field
      // existed carry no activation_condition key and skip the comparison
      // (legacy leniency); rows written now always carry it.
      if ('activation_condition' in row
        && JSON.stringify(node.activation_condition ?? null) !== JSON.stringify(row.activation_condition ?? null)) {
        return false;
      }
      if (row.posterior_marked_stale === true) {
        const posterior = node.posterior as Record<string, unknown> | null | undefined;
        if (!posterior || posterior.status !== 'stale') {
          return false;
        }
      }
      return true;
    };
    // The exact entry the executor would have appended for a row (same key
    // order, same values): used both to repair a torn final line and to
    // complete missing lines.
    const rebuildEntry = (row: Record<string, unknown>): Record<string, unknown> => ({
      mutation: 'apply_evidence_event',
      node_id: row.node_id,
      revision: Number(row.revision),
      event_group: eventGroup,
      evidence_ref: String(payload.evidence_ref),
      event_reason: String(payload.event_reason),
      reason: String(row.lifecycle_reason ?? payload.event_reason),
      ...(row.posterior_marked_stale === true ? { posterior_marked_stale: true } : {}),
      node: nodes[String(row.node_id)],
    });
    let logEntries: Array<Record<string, unknown>>;
    try {
      logEntries = store.loadNodeLogEntriesStrict(campaignId);
    } catch (error) {
      if (!(error instanceof NodeLogCorruptionError)) {
        throw error;
      }
      // A crash mid-append tears the final JSONL line. Repair is attempted
      // ONLY when the torn fragment carries THIS event's group id: a short
      // fragment is a byte prefix of many events' entries, and repairing
      // it with our entry would replace another event's torn line with our
      // provenance. The group id sits early in the serialized entry and is
      // operation-keyed (deterministic collisions eliminated; residual
      // truncated-48-bit-hash odds accepted), so its presence attributes
      // the fragment; fragments torn before it stay fail-closed (manual
      // inspection, no fabrication). Each store-matching row's expected
      // entry is tried in turn — the repair helper throws on a non-prefix
      // candidate, which just means "not this row", not corruption.
      const rawLog = readFileSync(store.nodesLogPath(campaignId), 'utf8');
      const fragment = rawLog.split('\n').filter(line => line.trim().length > 0).at(-1) ?? '';
      // The group id is fixed-length, so a fragment ending right after it —
      // before the closing quote — is already attributed beyond doubt; do
      // not demand the quote byte.
      if (!fragment.includes(`"event_group":"${eventGroup}`)) {
        throw error;
      }
      const repaired = rows.some(row => {
        if (!rowMatchesStore(row)) {
          return false;
        }
        try {
          return store.repairTornFinalNodeLogEntry(campaignId, rebuildEntry(row));
        } catch {
          return false;
        }
      });
      if (!repaired) {
        throw error;
      }
      logEntries = store.loadNodeLogEntriesStrict(campaignId);
    }
    const matchedRows = rows.filter(rowMatchesStore).length;
    const loggedNodeIds = new Set<string>();
    // Same-stamp foreign candidates: another evidence event wrote one of
    // our nodes at exactly the recorded timestamp (the production clock has
    // one-second resolution, so distinct events CAN share it). A row match
    // then no longer proves OUR event landed — but only when the foreign
    // write could EQUALLY explain the observed store state: it must match
    // the same complete tuple the store probe checks. A foreign same-second
    // write with a different revision, state, or reason cannot be what the
    // store shows and must not block a legitimate recovery.
    const explainsRow = (row: Record<string, unknown>, candidate: {
      activation_condition?: unknown;
      lifecycle_reason?: unknown;
      lifecycle_state?: unknown;
      revision?: unknown;
      updated_at?: unknown;
    }): boolean =>
      String(candidate.updated_at ?? '') === row.updated_at
      && candidate.lifecycle_state === row.lifecycle_state
      && Number(candidate.revision) === Number(row.revision)
      && (candidate.lifecycle_reason ?? null) === (row.lifecycle_reason ?? null)
      && (!('activation_condition' in row)
        || JSON.stringify(candidate.activation_condition ?? null) === JSON.stringify(row.activation_condition ?? null));
    // Foreign-writer scan is METHOD-AGNOSTIC: any mutation's ledger line
    // embeds the full written node, and a same-second write through ANY
    // path (a hand set_lifecycle retry is the natural operator move after
    // a failed batch call) could equally explain the observed state.
    let foreignSameStampLine = false;
    for (const entry of logEntries) {
      if (entry.mutation === 'apply_evidence_event' && entry.event_group === eventGroup) {
        loggedNodeIds.add(String(entry.node_id));
        continue;
      }
      const row = rowByNodeId.get(String(entry.node_id));
      const entryNode = entry.node && typeof entry.node === 'object' && !Array.isArray(entry.node)
        ? entry.node as Record<string, unknown>
        : null;
      if (row && entryNode && explainsRow(row, {
        activation_condition: entryNode.activation_condition,
        lifecycle_reason: entryNode.lifecycle_reason,
        lifecycle_state: entryNode.lifecycle_state,
        revision: entryNode.revision,
        updated_at: entryNode.updated_at,
      })) {
        foreignSameStampLine = true;
      }
    }
    // A twin's prepared idempotency record exists BEFORE its node write, so
    // scan OTHER records for writes covering our nodes at the recorded
    // timestamp — method-agnostic: batch records carry per-node rows,
    // single-node mutations (set_lifecycle / set_posterior /
    // set_grounding_audit) carry a node summary with the same comparable
    // fields. This decides the twin case even when the twin's ledger lines
    // were lost in the same crash.
    let foreignSameStampRecord = false;
    const idempotencyRecords = store.loadIdempotency<Record<string, unknown>>(campaignId) as unknown as Record<string, IdempotencyRecord>;
    for (const [, other] of Object.entries(idempotencyRecords)) {
      if (other.response.kind !== 'result') {
        continue;
      }
      const otherPayload = other.response.payload;
      if (otherPayload.event_group === eventGroup) {
        continue;
      }
      const candidates: Array<Record<string, unknown>> = [];
      if (Array.isArray(otherPayload.nodes)) {
        candidates.push(...otherPayload.nodes as Array<Record<string, unknown>>);
      }
      if (otherPayload.node && typeof otherPayload.node === 'object' && !Array.isArray(otherPayload.node)) {
        candidates.push(otherPayload.node as Record<string, unknown>);
      }
      for (const otherRow of candidates) {
        const row = rowByNodeId.get(String(otherRow.node_id));
        if (row && explainsRow(row, otherRow)) {
          foreignSameStampRecord = true;
        }
      }
    }
    if (loggedNodeIds.size === 0) {
      if (matchedRows === 0) {
        return false;
      }
      if (foreignSameStampLine || foreignSameStampRecord) {
        // Ambiguous attribution: the store state matches our rows, but a
        // DIFFERENT event's ledger line covers one of our nodes at the same
        // timestamp — the matching state may be that event's work, not
        // ours. Fabricating our lines here is exactly the false
        // certification this probe exists to prevent.
        throw new RpcError(-32603, 'internal_error', {
          reason: 'evidence_event_recovery_conflict',
          campaign_id: campaignId,
          details: {
            message: 'another evidence event wrote these nodes at the same timestamp; whether this event ever landed cannot be decided from the store — inspect the ledger before retrying',
          },
        });
      }
    }
    for (const row of rows) {
      const nodeId = String(row.node_id);
      if (loggedNodeIds.has(nodeId)) {
        continue;
      }
      if (!rowMatchesStore(row)) {
        // The event landed (some row or log line proves it), this node's
        // ledger line is missing, and the node has been mutated since — the
        // as-of-event node snapshot the ledger embeds cannot be faithfully
        // reconstructed. Fail loud instead of stamping fiction.
        throw new RpcError(-32603, 'internal_error', {
          reason: 'evidence_event_recovery_conflict',
          campaign_id: campaignId,
          details: {
            node_id: nodeId,
            message: 'evidence event landed but this node\'s ledger line is missing and the node has been mutated since; the as-of-event snapshot cannot be reconstructed — restore the store from its history before retrying',
          },
        });
      }
      store.appendNodeLogEntry(campaignId, rebuildEntry(row));
    }
    return true;
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
      // closed here. rewrite_provenance resets the audit whenever it changes the
      // active card claim, which covers the common (no-crash) case; a
      // provenance-only rewrite leaves the audit in place because the card did
      // not change. This narrow crash-window residual is the same class as
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
