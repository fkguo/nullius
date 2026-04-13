import { invalidParams } from '@autoresearch/shared';
import { ensureA3Approval } from './approval.js';
import { prepareManifest } from './manifest.js';
import { compileExecutionPlan, type StagedIdeaSurface } from './execution-plan.js';
import { executionPlanArtifactPath, executionPlanRelativePath, materializeExecutionPlan } from './materialize-execution-plan.js';
import { sha256File, toPosixRelative, writeJsonAtomic } from './io.js';
import { type ExecuteComputationManifestResult } from './types.js';

export interface ComputeBridgeInput {
  projectRoot: string;
  runId: string;
  runDir: string;
  dryRun?: boolean;
  stagedIdea: StagedIdeaSurface;
}

export type ComputeBridgeResult = ExecuteComputationManifestResult & {
  execution_plan_path: string;
  execution_plan_sha256: string;
  manifest_path: string;
  manifest_sha256: string;
  task_ids: string[];
  expected_artifacts: string[];
};

export async function bridgeStagedIdeaToComputation(
  input: ComputeBridgeInput,
): Promise<ComputeBridgeResult> {
  const executionPlan = compileExecutionPlan(input.runId, input.stagedIdea);
  const planPath = executionPlanArtifactPath(input.runDir);
  writeJsonAtomic(planPath, executionPlan);
  const { manifestPath } = materializeExecutionPlan(input.runDir, executionPlan);
  const prepared = prepareManifest({
    dryRun: input.dryRun,
    manifestPath,
    projectRoot: input.projectRoot,
    runDir: input.runDir,
    runId: input.runId,
  });
  const result = input.dryRun
    ? {
      status: 'dry_run' as const,
      validated: true as const,
      dry_run: true as const,
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
    }
    : (() => {
      const approval = ensureA3Approval(input.projectRoot, prepared);
      if (!approval) {
        throw invalidParams(
          'Bridge surface stops before execution even when A3 is already satisfied; use orch_run_execute_manifest for any post-approval execution.',
          {
            gate_id: 'A3',
            manifest_path: prepared.manifestRelativePath,
            validation_layer: 'approval_boundary',
          },
        );
      }
      return approval;
    })();
  return {
    ...result,
    execution_plan_path: executionPlanRelativePath(input.runDir),
    execution_plan_sha256: sha256File(planPath),
    manifest_path: toPosixRelative(input.runDir, manifestPath),
    manifest_sha256: sha256File(manifestPath),
    task_ids: executionPlan.tasks.map(task => task.task_id),
    expected_artifacts: executionPlan.tasks.flatMap(task => task.expected_artifacts.map(artifact => artifact.path)),
  };
}
