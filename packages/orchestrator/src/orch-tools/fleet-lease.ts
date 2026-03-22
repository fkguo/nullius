import type { FleetQueueClaim, FleetQueueV1 } from '@autoresearch/shared';

const ISO_TRIMMED_MILLIS = /\.\d{3}Z$/;
export const DEFAULT_FLEET_LEASE_DURATION_SECONDS = 60;

export type AutoReleasedFleetClaim = {
  queue_item_id: string;
  run_id: string;
  prior_claim_id: string;
  prior_owner_id: string;
  prior_lease_expires_at: string;
  lease_duration_seconds: number;
};

function parseIsoMs(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const value = Date.parse(iso);
  return Number.isNaN(value) ? null : value;
}

function addSecondsToIso(baseIso: string, seconds: number): string {
  const baseMs = parseIsoMs(baseIso);
  if (baseMs === null) return baseIso;
  return new Date(baseMs + (seconds * 1000)).toISOString().replace(ISO_TRIMMED_MILLIS, 'Z');
}

function clearClaim(item: FleetQueueV1['items'][number], nextStatus: FleetQueueV1['items'][number]['status']): void {
  item.status = nextStatus;
  delete item.claim;
}

export function resolveFleetLeaseDurationSeconds(input?: number): number {
  return input ?? DEFAULT_FLEET_LEASE_DURATION_SECONDS;
}

export function buildFleetLeaseClaim(input: {
  claim_id: string;
  owner_id: string;
  claimed_at: string;
  lease_duration_seconds?: number;
}): FleetQueueClaim {
  const leaseDurationSeconds = resolveFleetLeaseDurationSeconds(input.lease_duration_seconds);
  return {
    claim_id: input.claim_id,
    owner_id: input.owner_id,
    claimed_at: input.claimed_at,
    lease_duration_seconds: leaseDurationSeconds,
    lease_expires_at: addSecondsToIso(input.claimed_at, leaseDurationSeconds),
  };
}

export function renewFleetLeaseClaim(claim: FleetQueueClaim, renewedAt: string): FleetQueueClaim {
  return {
    ...claim,
    lease_expires_at: addSecondsToIso(renewedAt, claim.lease_duration_seconds),
  };
}

export function getFleetLeaseRemainingSeconds(claim: FleetQueueClaim | null | undefined, nowIso: string): number | null {
  if (!claim) return null;
  const expiresAtMs = parseIsoMs(claim.lease_expires_at);
  const nowMs = parseIsoMs(nowIso);
  if (expiresAtMs === null || nowMs === null) return null;
  return Math.max(Math.floor((expiresAtMs - nowMs) / 1000), 0);
}

export function isFleetLeaseExpired(claim: FleetQueueClaim | null | undefined, nowIso: string): boolean {
  if (!claim) return false;
  const expiresAtMs = parseIsoMs(claim.lease_expires_at);
  const nowMs = parseIsoMs(nowIso);
  if (expiresAtMs === null || nowMs === null) return false;
  return expiresAtMs <= nowMs;
}

export function renewOwnedFleetClaims(
  queue: FleetQueueV1,
  ownerId: string,
  nowIso: string,
): number {
  let renewedCount = 0;
  for (const item of queue.items) {
    const claim = item.status === 'claimed' ? item.claim : undefined;
    if (!claim || claim.owner_id !== ownerId || isFleetLeaseExpired(claim, nowIso)) continue;
    item.claim = renewFleetLeaseClaim(claim, nowIso);
    renewedCount += 1;
  }
  return renewedCount;
}

export function autoReleaseExpiredFleetClaims(
  queue: FleetQueueV1,
  nowIso: string,
): AutoReleasedFleetClaim[] {
  const released: AutoReleasedFleetClaim[] = [];
  for (const item of queue.items) {
    const claim = item.status === 'claimed' ? item.claim : undefined;
    if (!claim || !isFleetLeaseExpired(claim, nowIso)) continue;
    released.push({
      queue_item_id: item.queue_item_id,
      run_id: item.run_id,
      prior_claim_id: claim.claim_id,
      prior_owner_id: claim.owner_id,
      prior_lease_expires_at: claim.lease_expires_at,
      lease_duration_seconds: claim.lease_duration_seconds,
    });
    clearClaim(item, 'queued');
    item.attempt_count += 1;
  }
  return released;
}
