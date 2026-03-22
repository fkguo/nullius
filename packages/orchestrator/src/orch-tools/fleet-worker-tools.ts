import { randomUUID } from 'node:crypto';
import { invalidParams, type FleetQueueV1 } from '@autoresearch/shared';
import { utcNowIso } from '../util.js';
import { createStateManager } from './common.js';
import { readFleetQueue, writeFleetQueue, type FleetQueueItem } from './fleet-queue-store.js';
import {
  buildFleetWorkerView,
  createEmptyFleetWorkers,
  fleetWorkersPath,
  readFleetWorkers,
  upsertFleetWorker,
  writeFleetWorkers,
} from './fleet-worker-store.js';
import {
  autoReleaseExpiredFleetClaims,
  buildFleetLeaseClaim,
  renewOwnedFleetClaims,
} from './fleet-lease.js';
import { sortQueuedItems } from './fleet-queue-tools.js';
import { OrchFleetWorkerHeartbeatSchema, OrchFleetWorkerPollSchema } from './schemas.js';

function activeClaimsByWorker(queue: FleetQueueV1 | null): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of queue?.items ?? []) {
    if (item.status !== 'claimed' || !item.claim) continue;
    counts[item.claim.owner_id] = (counts[item.claim.owner_id] ?? 0) + 1;
  }
  return counts;
}

function requireValidFleetWorkers(projectRoot: string) {
  const readResult = readFleetWorkers(projectRoot);
  if (readResult.errors.length > 0) {
    throw invalidParams('fleet worker registry is invalid', {
      fleet_workers_path: fleetWorkersPath(projectRoot),
      errors: readResult.errors,
    });
  }
  return readResult.registry ?? createEmptyFleetWorkers();
}

function requireValidQueue(projectRoot: string) {
  const readResult = readFleetQueue(projectRoot);
  if (readResult.errors.length > 0) {
    throw invalidParams('fleet queue is invalid', {
      fleet_queue_path: `${projectRoot}/.autoresearch/fleet_queue.json`,
      errors: readResult.errors,
    });
  }
  return readResult.queue;
}

function claimNextQueuedItem(
  queue: FleetQueueV1,
  workerId: string,
  claimedAt: string,
  leaseDurationSeconds?: number,
): FleetQueueItem | null {
  const target = sortQueuedItems(queue.items.filter(item => item.status === 'queued'))[0];
  if (!target) {
    return null;
  }
  target.status = 'claimed';
  target.claim = buildFleetLeaseClaim({
    claim_id: `fqc_${randomUUID()}`,
    owner_id: workerId,
    claimed_at: claimedAt,
    lease_duration_seconds: leaseDurationSeconds,
  });
  return { ...target };
}

function appendAutoReleasedEvents(
  manager: ReturnType<typeof createStateManager>['manager'],
  autoReleased: ReturnType<typeof autoReleaseExpiredFleetClaims>,
  workerId: string,
): void {
  for (const released of autoReleased) {
    manager.appendLedger('fleet_claim_auto_released', {
      run_id: released.run_id,
      workflow_id: null,
      details: {
        queue_item_id: released.queue_item_id,
        prior_claim_id: released.prior_claim_id,
        prior_owner_id: released.prior_owner_id,
        prior_lease_expires_at: released.prior_lease_expires_at,
        lease_duration_seconds: released.lease_duration_seconds,
        disposition: 'requeue',
        reason: 'LEASE_EXPIRED',
        triggered_by: 'worker_poll',
        trigger_worker_id: workerId,
      },
    });
  }
}

function noClaimResponse(
  projectRoot: string,
  worker: ReturnType<typeof buildFleetWorkerView>,
  reason: 'NO_QUEUED_ITEM' | 'AT_CAPACITY',
  diagnostic: string,
) {
  return {
    claimed: false,
    project_root: projectRoot,
    reason,
    diagnostic,
    queue_item: null,
    worker,
  };
}

export async function handleOrchFleetWorkerHeartbeat(
  params: Parameters<typeof OrchFleetWorkerHeartbeatSchema.parse>[0],
): Promise<unknown> {
  const parsed = OrchFleetWorkerHeartbeatSchema.parse(params);
  const { manager, projectRoot } = createStateManager(parsed.project_root);
  const nowIso = utcNowIso();
  const registry = requireValidFleetWorkers(projectRoot);
  const worker = upsertFleetWorker(registry, parsed, nowIso);

  writeFleetWorkers(projectRoot, registry);
  manager.appendLedger('fleet_worker_heartbeat', {
    run_id: null,
    workflow_id: null,
    details: { worker_id: worker.worker_id, max_concurrent_claims: worker.max_concurrent_claims },
  });
  return {
    heartbeat_recorded: true,
    project_root: projectRoot,
    worker: { ...worker, health_status: 'healthy' },
  };
}

export async function handleOrchFleetWorkerPoll(
  params: Parameters<typeof OrchFleetWorkerPollSchema.parse>[0],
): Promise<unknown> {
  const parsed = OrchFleetWorkerPollSchema.parse(params);
  const { manager, projectRoot } = createStateManager(parsed.project_root);
  const nowIso = utcNowIso();
  const registry = requireValidFleetWorkers(projectRoot);
  const queue = requireValidQueue(projectRoot);
  const worker = upsertFleetWorker(registry, parsed, nowIso);

  writeFleetWorkers(projectRoot, registry);
  manager.appendLedger('fleet_worker_heartbeat', {
    run_id: null,
    workflow_id: null,
    details: { worker_id: worker.worker_id, max_concurrent_claims: worker.max_concurrent_claims },
  });

  let queueChanged = false;
  let autoReleased = [] as ReturnType<typeof autoReleaseExpiredFleetClaims>;
  if (queue) {
    queueChanged = renewOwnedFleetClaims(queue, worker.worker_id, nowIso) > 0;
    autoReleased = autoReleaseExpiredFleetClaims(queue, nowIso);
    queueChanged = queueChanged || autoReleased.length > 0;
  }

  const claimsByWorker = activeClaimsByWorker(queue);

  const workerView = buildFleetWorkerView(worker, claimsByWorker[worker.worker_id] ?? 0, nowIso);
  if (workerView.available_slots < 1) {
    if (queue && queueChanged) {
      writeFleetQueue(projectRoot, queue);
      appendAutoReleasedEvents(manager, autoReleased, worker.worker_id);
    }
    return noClaimResponse(
      projectRoot,
      workerView,
      'AT_CAPACITY',
      `worker '${worker.worker_id}' is already at ${workerView.active_claim_count}/${worker.max_concurrent_claims} claim slots`,
    );
  }

  if (!queue) {
    return noClaimResponse(projectRoot, workerView, 'NO_QUEUED_ITEM', 'no queued fleet item is available to claim');
  }

  const claimedItem = claimNextQueuedItem(
    queue,
    worker.worker_id,
    nowIso,
    parsed.lease_duration_seconds,
  );
  if (!claimedItem) {
    if (queueChanged) {
      writeFleetQueue(projectRoot, queue);
      appendAutoReleasedEvents(manager, autoReleased, worker.worker_id);
    }
    return noClaimResponse(projectRoot, workerView, 'NO_QUEUED_ITEM', 'no queued fleet item is available to claim');
  }

  writeFleetQueue(projectRoot, queue);
  appendAutoReleasedEvents(manager, autoReleased, worker.worker_id);
  manager.appendLedger('fleet_claimed', {
    run_id: claimedItem.run_id,
    workflow_id: null,
    details: {
      queue_item_id: claimedItem.queue_item_id,
      owner_id: worker.worker_id,
      claim_id: claimedItem.claim?.claim_id,
      lease_duration_seconds: claimedItem.claim?.lease_duration_seconds,
      lease_expires_at: claimedItem.claim?.lease_expires_at,
      claimed_via: 'worker_poll',
    },
  });
  return {
    claimed: true,
    project_root: projectRoot,
    queue_item: claimedItem,
    worker: buildFleetWorkerView(worker, workerView.active_claim_count + 1, nowIso),
  };
}
