import { existsSync } from 'fs';
import { IdeaEngineStore } from '../store/engine-store.js';
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
    const rankingRef = record.response.payload.ranking_artifact_ref;
    return typeof rankingRef === 'string' && rankingRef.startsWith('file://') && existsSync(rankingRef.slice(7));
  }
  if (method === 'node.promote') {
    const handoffRef = record.response.payload.handoff_artifact_ref;
    return typeof handoffRef === 'string' && handoffRef.startsWith('file://') && existsSync(handoffRef.slice(7));
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
  if (method === 'node.set_posterior' || method === 'node.set_lifecycle') {
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
    return nodeLifecycleState(node) === summary.lifecycle_state
      && JSON.stringify(node.activation_condition ?? null) === JSON.stringify(summary.activation_condition ?? null);
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
  if (options.kind === 'error') {
    return;
  }
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
