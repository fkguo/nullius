import { invalidParams } from '@autoresearch/shared';
import { createStateManager } from './common.js';
import { fleetQueuePath, readFleetQueue } from './fleet-queue-store.js';
import {
  fleetWorkersPath,
  readFleetWorkers,
  writeFleetWorkers,
} from './fleet-worker-store.js';
import { OrchFleetWorkerUnregisterSchema } from './schemas.js';

function requireValidFleetWorkers(projectRoot: string) {
  const readResult = readFleetWorkers(projectRoot);
  if (readResult.errors.length > 0) {
    throw invalidParams('fleet worker registry is invalid', {
      fleet_workers_path: fleetWorkersPath(projectRoot),
      errors: readResult.errors,
    });
  }
  return readResult.registry;
}

function requireValidQueue(projectRoot: string) {
  const readResult = readFleetQueue(projectRoot);
  if (readResult.errors.length > 0) {
    throw invalidParams('fleet queue is invalid', {
      fleet_queue_path: fleetQueuePath(projectRoot),
      errors: readResult.errors,
    });
  }
  return readResult.queue;
}

function activeClaimCountForWorker(projectRoot: string, workerId: string): number {
  const queue = requireValidQueue(projectRoot);
  if (!queue) {
    return 0;
  }
  return queue.items.filter(
    item => item.status === 'claimed' && item.claim?.owner_id === workerId,
  ).length;
}

export async function handleOrchFleetWorkerUnregister(
  params: Parameters<typeof OrchFleetWorkerUnregisterSchema.parse>[0],
): Promise<unknown> {
  const parsed = OrchFleetWorkerUnregisterSchema.parse(params);
  const { manager, projectRoot } = createStateManager(parsed.project_root);
  const registry = requireValidFleetWorkers(projectRoot);
  if (!registry) {
    throw invalidParams(`unknown worker_id '${parsed.worker_id}' for ${projectRoot}`, {
      project_root: projectRoot,
      worker_id: parsed.worker_id,
      fleet_workers_path: fleetWorkersPath(projectRoot),
    });
  }

  const workerIndex = registry.workers.findIndex(candidate => candidate.worker_id === parsed.worker_id);
  if (workerIndex < 0) {
    throw invalidParams(`unknown worker_id '${parsed.worker_id}' for ${projectRoot}`, {
      project_root: projectRoot,
      worker_id: parsed.worker_id,
      fleet_workers_path: fleetWorkersPath(projectRoot),
    });
  }

  const worker = registry.workers[workerIndex];
  if (worker.accepts_claims !== false) {
    throw invalidParams(`worker_id '${parsed.worker_id}' must stop accepting claims before unregister`, {
      project_root: projectRoot,
      worker_id: parsed.worker_id,
      accepts_claims: worker.accepts_claims,
    });
  }

  const activeClaimCount = activeClaimCountForWorker(projectRoot, parsed.worker_id);
  if (activeClaimCount > 0) {
    throw invalidParams(`worker_id '${parsed.worker_id}' still owns active fleet claims`, {
      project_root: projectRoot,
      worker_id: parsed.worker_id,
      active_claim_count: activeClaimCount,
    });
  }

  registry.workers.splice(workerIndex, 1);
  writeFleetWorkers(projectRoot, registry);
  manager.appendLedger('fleet_worker_unregistered', {
    run_id: null,
    workflow_id: null,
    details: {
      worker_id: parsed.worker_id,
      unregistered_by: parsed.unregistered_by,
      note: parsed.note,
    },
  });

  return {
    unregistered: true,
    project_root: projectRoot,
    worker_id: parsed.worker_id,
    active_claim_count: 0,
  };
}
