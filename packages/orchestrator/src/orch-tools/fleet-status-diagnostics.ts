import { utcNowIso } from '../util.js';
import { getFleetLeaseRemainingSeconds, isFleetLeaseExpired } from './fleet-lease.js';
import type { ReadModelError } from './run-read-model.js';
import type { FleetQueueItemView, FleetQueueView } from './fleet-queue-store.js';
import type { FleetWorkerHealth, FleetWorkerView } from './fleet-worker-store.js';

export type FleetAttentionReason =
  | 'OWNER_WORKER_MISSING'
  | 'OWNER_WORKER_STALE'
  | 'CLAIM_WITHOUT_OWNER'
  | 'QUEUE_OR_WORKER_REGISTRY_INVALID';

export type FleetQueueDiagnosticItemView = FleetQueueItemView & {
  claim_age_seconds: number | null;
  lease_expires_at: string | null;
  lease_remaining_seconds: number | null;
  lease_expired: boolean;
  last_heartbeat_at: string | null;
  last_heartbeat_age_seconds: number | null;
  owner_worker_health: FleetWorkerHealth | null;
  attention_required: boolean;
  attention_reasons: FleetAttentionReason[];
};

export type FleetQueueAttentionSummary = {
  attention_claim_count: number;
  claimed_without_worker_count: number;
  claimed_with_stale_worker_count: number;
  expired_claim_count: number;
};

export type FleetQueueDiagnosticView = Omit<FleetQueueView, 'items'> & FleetQueueAttentionSummary & {
  items: FleetQueueDiagnosticItemView[];
};

function ageSeconds(iso: string | null | undefined, nowIso: string): number | null {
  if (!iso) return null;
  const startMs = Date.parse(iso);
  const nowMs = Date.parse(nowIso);
  if (Number.isNaN(startMs) || Number.isNaN(nowMs)) return null;
  return Math.max(Math.floor((nowMs - startMs) / 1000), 0);
}

function hasRegistryError(errors: ReadModelError[]): boolean {
  return errors.some(error =>
    error.code === 'FLEET_QUEUE_PARSE_ERROR'
    || error.code === 'FLEET_QUEUE_SCHEMA_ERROR'
    || error.code === 'FLEET_WORKERS_PARSE_ERROR'
    || error.code === 'FLEET_WORKERS_SCHEMA_ERROR',
  );
}

export function buildFleetQueueDiagnosticItems(
  items: FleetQueueItemView[],
  workers: FleetWorkerView[],
  errors: ReadModelError[],
  nowIso = utcNowIso(),
): FleetQueueDiagnosticItemView[] {
  const workersById = new Map(workers.map(worker => [worker.worker_id, worker]));
  const registryInvalid = hasRegistryError(errors);

  return items.map(item => {
    if (item.status !== 'claimed') {
      return {
        ...item,
        claim_age_seconds: null,
        lease_expires_at: null,
        lease_remaining_seconds: null,
        lease_expired: false,
        last_heartbeat_at: null,
        last_heartbeat_age_seconds: null,
        owner_worker_health: null,
        attention_required: false,
        attention_reasons: [],
      };
    }

    const ownerId = item.claim?.owner_id ?? null;
    const ownerWorker = ownerId ? workersById.get(ownerId) ?? null : null;
    const reasons: FleetAttentionReason[] = [];
    if (!ownerId) reasons.push('CLAIM_WITHOUT_OWNER');
    if (registryInvalid) reasons.push('QUEUE_OR_WORKER_REGISTRY_INVALID');
    if (ownerId && !ownerWorker && !registryInvalid) reasons.push('OWNER_WORKER_MISSING');
    if (ownerWorker?.health_status === 'stale') reasons.push('OWNER_WORKER_STALE');

    return {
      ...item,
      claim_age_seconds: ageSeconds(item.claim?.claimed_at, nowIso),
      lease_expires_at: item.claim?.lease_expires_at ?? null,
      lease_remaining_seconds: getFleetLeaseRemainingSeconds(item.claim, nowIso),
      lease_expired: isFleetLeaseExpired(item.claim, nowIso),
      last_heartbeat_at: ownerWorker?.last_heartbeat_at ?? null,
      last_heartbeat_age_seconds: ageSeconds(ownerWorker?.last_heartbeat_at, nowIso),
      owner_worker_health: ownerWorker?.health_status ?? null,
      attention_required: reasons.length > 0,
      attention_reasons: reasons,
    };
  });
}

export function summarizeFleetQueueAttention(items: FleetQueueDiagnosticItemView[]): FleetQueueAttentionSummary {
  let attentionClaimCount = 0;
  let claimedWithoutWorkerCount = 0;
  let claimedWithStaleWorkerCount = 0;
  let expiredClaimCount = 0;

  for (const item of items) {
    if (item.status !== 'claimed') continue;
    if (item.attention_required) attentionClaimCount += 1;
    if (item.attention_reasons.includes('OWNER_WORKER_MISSING')) claimedWithoutWorkerCount += 1;
    if (item.attention_reasons.includes('OWNER_WORKER_STALE')) claimedWithStaleWorkerCount += 1;
    if (item.lease_expired) expiredClaimCount += 1;
  }

  return {
    attention_claim_count: attentionClaimCount,
    claimed_without_worker_count: claimedWithoutWorkerCount,
    claimed_with_stale_worker_count: claimedWithStaleWorkerCount,
    expired_claim_count: expiredClaimCount,
  };
}
