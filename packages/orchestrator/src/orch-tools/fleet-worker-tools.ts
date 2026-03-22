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

function claimNextQueuedItem(queue: FleetQueueV1, workerId: string, claimedAt: string): FleetQueueItem | null {
  const target = sortQueuedItems(queue.items.filter(item => item.status === 'queued'))[0];
  if (!target) {
    return null;
  }
  target.status = 'claimed';
  target.claim = {
    claim_id: `fqc_${randomUUID()}`,
    owner_id: workerId,
    claimed_at: claimedAt,
  };
  return { ...target };
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
  const claimsByWorker = activeClaimsByWorker(queue);

  writeFleetWorkers(projectRoot, registry);
  manager.appendLedger('fleet_worker_heartbeat', {
    run_id: null,
    workflow_id: null,
    details: { worker_id: worker.worker_id, max_concurrent_claims: worker.max_concurrent_claims },
  });

  const workerView = buildFleetWorkerView(worker, claimsByWorker[worker.worker_id] ?? 0, nowIso);
  if (workerView.available_slots < 1) {
    return {
      claimed: false,
      project_root: projectRoot,
      reason: 'AT_CAPACITY',
      diagnostic: `worker '${worker.worker_id}' is already at ${workerView.active_claim_count}/${worker.max_concurrent_claims} claim slots`,
      queue_item: null,
      worker: workerView,
    };
  }

  if (!queue) {
    return {
      claimed: false,
      project_root: projectRoot,
      reason: 'NO_QUEUED_ITEM',
      diagnostic: 'no queued fleet item is available to claim',
      queue_item: null,
      worker: workerView,
    };
  }

  const claimedItem = claimNextQueuedItem(queue, worker.worker_id, nowIso);
  if (!claimedItem) {
    return {
      claimed: false,
      project_root: projectRoot,
      reason: 'NO_QUEUED_ITEM',
      diagnostic: 'no queued fleet item is available to claim',
      queue_item: null,
      worker: workerView,
    };
  }

  writeFleetQueue(projectRoot, queue);
  manager.appendLedger('fleet_claimed', {
    run_id: claimedItem.run_id,
    workflow_id: null,
    details: {
      queue_item_id: claimedItem.queue_item_id,
      owner_id: worker.worker_id,
      claim_id: claimedItem.claim?.claim_id,
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
