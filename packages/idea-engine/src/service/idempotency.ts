import { existsSync } from 'fs';
import { IdeaEngineStore } from '../store/engine-store.js';
import { budgetSnapshot } from './budget-snapshot.js';
import { RpcError } from './errors.js';

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
  if (method === 'search.step') {
    const campaignId = record.response.payload.campaign_id;
    const stepId = record.response.payload.step_id;
    if (typeof campaignId !== 'string' || typeof stepId !== 'string') {
      return false;
    }
    const campaign = store.loadCampaign<Record<string, unknown>>(campaignId);
    if (!campaign || campaign.last_step_id !== stepId) {
      return false;
    }
    if (!existsSync(store.artifactPath(campaignId, 'search_steps', `${stepId}.json`))) {
      return false;
    }
    const newNodeIds = Array.isArray(record.response.payload.new_node_ids) ? record.response.payload.new_node_ids : [];
    if (newNodeIds.length === 0) {
      return true;
    }
    const newNodesRef = record.response.payload.new_nodes_artifact_ref;
    if (typeof newNodesRef !== 'string' || !newNodesRef.startsWith('file://')) {
      return false;
    }
    const nodes = store.loadNodes<Record<string, unknown>>(campaignId);
    return newNodeIds.every(nodeId => typeof nodeId === 'string' && nodeId in nodes);
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
  if (method === 'eval.run') {
    const scorecardsRef = record.response.payload.scorecards_artifact_ref;
    return typeof scorecardsRef === 'string' && scorecardsRef.startsWith('file://') && existsSync(scorecardsRef.slice(7));
  }
  if (method === 'rank.compute') {
    const rankingRef = record.response.payload.ranking_artifact_ref;
    return typeof rankingRef === 'string' && rankingRef.startsWith('file://') && existsSync(rankingRef.slice(7));
  }
  if (method === 'node.promote') {
    const handoffRef = record.response.payload.handoff_artifact_ref;
    return typeof handoffRef === 'string' && handoffRef.startsWith('file://') && existsSync(handoffRef.slice(7));
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
