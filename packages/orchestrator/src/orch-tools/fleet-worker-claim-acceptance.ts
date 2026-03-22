import { invalidParams } from '@autoresearch/shared';
import { createStateManager } from './common.js';
import {
  fleetWorkersPath,
  readFleetWorkers,
  writeFleetWorkers,
} from './fleet-worker-store.js';
import { OrchFleetWorkerSetClaimAcceptanceSchema } from './schemas.js';

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

export async function handleOrchFleetWorkerSetClaimAcceptance(
  params: Parameters<typeof OrchFleetWorkerSetClaimAcceptanceSchema.parse>[0],
): Promise<unknown> {
  const parsed = OrchFleetWorkerSetClaimAcceptanceSchema.parse(params);
  const { manager, projectRoot } = createStateManager(parsed.project_root);
  const registry = requireValidFleetWorkers(projectRoot);
  if (!registry) {
    throw invalidParams(`unknown worker_id '${parsed.worker_id}' for ${projectRoot}`, {
      project_root: projectRoot,
      worker_id: parsed.worker_id,
      fleet_workers_path: fleetWorkersPath(projectRoot),
    });
  }
  const worker = registry?.workers.find(candidate => candidate.worker_id === parsed.worker_id);

  if (!worker) {
    throw invalidParams(`unknown worker_id '${parsed.worker_id}' for ${projectRoot}`, {
      project_root: projectRoot,
      worker_id: parsed.worker_id,
      fleet_workers_path: fleetWorkersPath(projectRoot),
    });
  }

  const priorAcceptsClaims = worker.accepts_claims;
  worker.accepts_claims = parsed.accepts_claims;
  writeFleetWorkers(projectRoot, registry);
  manager.appendLedger('fleet_worker_claim_acceptance_updated', {
    run_id: null,
    workflow_id: null,
    details: {
      worker_id: worker.worker_id,
      prior_accepts_claims: priorAcceptsClaims,
      accepts_claims: worker.accepts_claims,
      updated_by: parsed.updated_by,
      note: parsed.note,
    },
  });

  return {
    updated: true,
    project_root: projectRoot,
    worker: { ...worker },
  };
}
