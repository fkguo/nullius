import { prepareManifest } from './manifest.js';
import { ensureA3Approval } from './approval.js';
import { runPreparedManifest } from './runner.js';
import type {
  DryRunExecutionResult,
  ExecuteComputationManifestInput,
  ExecuteComputationManifestResult,
} from './types.js';

function dryRunResult(input: ExecuteComputationManifestInput): DryRunExecutionResult {
  const prepared = prepareManifest(input);
  return {
    status: 'dry_run',
    validated: true,
    dry_run: true,
    manifest_path: prepared.manifestRelativePath,
    manifest_sha256: prepared.manifestSha256,
    workspace_dir: prepared.workspaceDir,
    step_order: [...prepared.stepOrder],
    steps: prepared.stepOrder.map(stepId => {
      const step = prepared.steps.find(candidate => candidate.id === stepId)!;
      return {
        id: step.id,
        tool: step.tool,
        script: step.scriptRelativePath,
        command: [...step.argv],
        expected_outputs: [...step.expectedOutputs],
      };
    }),
  };
}

export async function executeComputationManifest(
  input: ExecuteComputationManifestInput,
): Promise<ExecuteComputationManifestResult> {
  if (input.dryRun) {
    return dryRunResult(input);
  }
  const prepared = prepareManifest(input);
  const approval = ensureA3Approval(input.projectRoot, prepared);
  if (approval) {
    return approval;
  }
  return runPreparedManifest(input.projectRoot, prepared);
}

export { bridgeStagedIdeaToComputation, type ComputeBridgeInput, type ComputeBridgeResult } from './bridge.js';
export {
  buildTeamConfigForDelegatedFollowupTask,
  type DelegatedFollowupTeamConfig,
} from './feedback-followups.js';
export type {
  ExecuteComputationManifestInput,
  ExecuteComputationManifestResult,
} from './types.js';
