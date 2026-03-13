import { bridgeStagedIdeaToComputation } from '@autoresearch/orchestrator';
import { getRun } from '../core/runs.js';
import { getRunDir } from '../core/paths.js';
import { loadStagedIdeaSurface } from './idea-staging.js';

export interface PlanComputationParams {
  project_root: string;
  run_id: string;
  dry_run?: boolean;
}

export async function planComputation(
  params: PlanComputationParams,
) {
  getRun(params.run_id);
  const runDir = getRunDir(params.run_id);
  const stagedIdea = loadStagedIdeaSurface(params.run_id);
  return bridgeStagedIdeaToComputation({
    dryRun: params.dry_run,
    projectRoot: params.project_root,
    runDir,
    runId: params.run_id,
    stagedIdea: {
      outline_seed_path: 'artifacts/outline_seed_v1.json',
      outline: stagedIdea.outlineSeed,
      hints: stagedIdea.hints,
    },
  });
}
