import { randomUUID } from 'node:crypto';
import {
  invalidParams,
  notFound,
  type FleetQueueV1,
  type FleetWorkersV1,
} from '@autoresearch/shared';
import { utcNowIso } from '../util.js';
import { createStateManager } from './common.js';
import { buildFleetLeaseClaim } from './fleet-lease.js';
import {
  createEmptyFleetQueue,
  fleetQueuePath,
  readFleetQueue,
  writeFleetQueue,
  type FleetQueueItem,
} from './fleet-queue-store.js';
import {
  fleetWorkersPath,
  readFleetWorkers,
  type FleetWorkerRecord,
} from './fleet-worker-store.js';
import { OrchFleetReassignClaimSchema } from './schemas.js';

function requireValidQueue(projectRoot: string): FleetQueueV1 {
  const readResult = readFleetQueue(projectRoot);
  if (readResult.errors.length > 0) {
    throw invalidParams('fleet queue is invalid', {
      fleet_queue_path: fleetQueuePath(projectRoot),
      errors: readResult.errors,
    });
  }
  return readResult.queue ?? createEmptyFleetQueue();
}

function requireClaimedItem(queue: FleetQueueV1, queueItemId: string, projectRoot: string): FleetQueueItem {
  const item = queue.items.find(entry => entry.queue_item_id === queueItemId);
  if (!item) {
    throw notFound(`unknown queue_item_id '${queueItemId}'`, {
      project_root: projectRoot,
      queue_item_id: queueItemId,
    });
  }
  if (item.status !== 'claimed' || !item.claim) {
    throw invalidParams(`queue item '${queueItemId}' is not currently claimed`, {
      project_root: projectRoot,
      queue_item_id: queueItemId,
      status: item.status,
    });
  }
  return item;
}

function requireValidWorkerRegistry(projectRoot: string): FleetWorkersV1 {
  const readResult = readFleetWorkers(projectRoot);
  if (readResult.errors.length > 0) {
    throw invalidParams('fleet worker registry is invalid', {
      fleet_workers_path: fleetWorkersPath(projectRoot),
      errors: readResult.errors,
    });
  }
  if (!readResult.registry) {
    throw invalidParams('fleet worker registry is not initialized', {
      fleet_workers_path: fleetWorkersPath(projectRoot),
      project_root: projectRoot,
    });
  }
  return readResult.registry;
}

function requireWorker(
  registry: FleetWorkersV1,
  workerId: string,
  projectRoot: string,
  role: 'current owner' | 'target',
): FleetWorkerRecord {
  const worker = registry.workers.find(entry => entry.worker_id === workerId);
  if (!worker) {
    throw invalidParams(`${role} worker '${workerId}' is not registered`, {
      fleet_workers_path: fleetWorkersPath(projectRoot),
      project_root: projectRoot,
      role,
      worker_id: workerId,
    });
  }
  return worker;
}

function activeClaimCountForWorker(queue: FleetQueueV1, workerId: string): number {
  return queue.items.filter(item =>
    item.status === 'claimed' && item.claim?.owner_id === workerId
  ).length;
}

export async function handleOrchFleetReassignClaim(
  params: Parameters<typeof OrchFleetReassignClaimSchema.parse>[0],
): Promise<unknown> {
  const parsed = OrchFleetReassignClaimSchema.parse(params);
  const { manager, projectRoot } = createStateManager(parsed.project_root);
  const queue = requireValidQueue(projectRoot);
  const item = requireClaimedItem(queue, parsed.queue_item_id, projectRoot);
  const claim = item.claim;
  if (!claim) {
    throw invalidParams(`queue item '${parsed.queue_item_id}' is missing claim metadata`, {
      project_root: projectRoot,
      queue_item_id: parsed.queue_item_id,
    });
  }
  if (claim.claim_id !== parsed.expected_claim_id) {
    throw invalidParams(`queue item '${parsed.queue_item_id}' claim_id changed since the operator inspected it`, {
      project_root: projectRoot,
      queue_item_id: parsed.queue_item_id,
      expected_claim_id: parsed.expected_claim_id,
      current_claim_id: claim.claim_id,
    });
  }
  if (claim.owner_id !== parsed.expected_owner_id) {
    throw invalidParams(`queue item '${parsed.queue_item_id}' owner changed since the operator inspected it`, {
      project_root: projectRoot,
      queue_item_id: parsed.queue_item_id,
      expected_owner_id: parsed.expected_owner_id,
      current_owner_id: claim.owner_id,
    });
  }
  if (parsed.target_worker_id === parsed.expected_owner_id) {
    throw invalidParams('target_worker_id must differ from the current owner worker', {
      project_root: projectRoot,
      expected_owner_id: parsed.expected_owner_id,
      target_worker_id: parsed.target_worker_id,
    });
  }

  const registry = requireValidWorkerRegistry(projectRoot);
  requireWorker(registry, parsed.expected_owner_id, projectRoot, 'current owner');
  const targetWorker = requireWorker(registry, parsed.target_worker_id, projectRoot, 'target');
  if (!targetWorker.accepts_claims) {
    throw invalidParams(`target worker '${parsed.target_worker_id}' is not accepting claims`, {
      project_root: projectRoot,
      target_worker_id: parsed.target_worker_id,
      accepts_claims: targetWorker.accepts_claims,
    });
  }

  const targetActiveClaimCount = activeClaimCountForWorker(queue, parsed.target_worker_id);
  if (targetActiveClaimCount >= targetWorker.max_concurrent_claims) {
    throw invalidParams(`target worker '${parsed.target_worker_id}' is already at capacity`, {
      project_root: projectRoot,
      target_worker_id: parsed.target_worker_id,
      active_claim_count: targetActiveClaimCount,
      max_concurrent_claims: targetWorker.max_concurrent_claims,
    });
  }

  const nextClaim = buildFleetLeaseClaim({
    claim_id: `fqc_${randomUUID()}`,
    owner_id: parsed.target_worker_id,
    claimed_at: utcNowIso(),
    lease_duration_seconds: claim.lease_duration_seconds,
  });
  const priorClaimId = claim.claim_id;
  const priorOwnerId = claim.owner_id;
  item.status = 'claimed';
  item.claim = nextClaim;

  writeFleetQueue(projectRoot, queue);
  manager.appendLedger('fleet_claim_reassigned', {
    run_id: item.run_id,
    workflow_id: null,
    details: {
      queue_item_id: item.queue_item_id,
      prior_claim_id: priorClaimId,
      prior_owner_id: priorOwnerId,
      new_claim_id: nextClaim.claim_id,
      new_owner_id: nextClaim.owner_id,
      lease_duration_seconds: nextClaim.lease_duration_seconds,
      reassigned_by: parsed.reassigned_by,
      note: parsed.note,
    },
  });

  return {
    reassigned: true,
    project_root: projectRoot,
    prior_claim_id: priorClaimId,
    prior_owner_id: priorOwnerId,
    queue_item: { ...item },
  };
}
