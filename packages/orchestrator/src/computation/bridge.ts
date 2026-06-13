import { ensureA3Approval } from './approval.js';
import { prepareManifest } from './manifest.js';
import { compileExecutionPlan, type StagedIdeaSurface } from './execution-plan.js';
import { executionPlanArtifactPath, executionPlanRelativePath, materializeExecutionPlan } from './materialize-execution-plan.js';
import { sha256File, toPosixRelative, writeJsonAtomic } from './io.js';
import { type ExecuteComputationManifestResult, type PlannedExecutionResult, type PreparedManifest } from './types.js';
import { StateManager } from '../state-manager.js';

export interface ComputeBridgeInput {
  projectRoot: string;
  runId: string;
  runDir: string;
  dryRun?: boolean;
  stagedIdea: StagedIdeaSurface;
}

export type ComputeBridgeResult = (ExecuteComputationManifestResult | PlannedExecutionResult) & {
  execution_plan_path: string;
  execution_plan_sha256: string;
  manifest_path: string;
  manifest_sha256: string;
  task_ids: string[];
  expected_artifacts: string[];
};

function ensurePlanningRunIsActive(projectRoot: string, runId: string): void {
  const manager = new StateManager(projectRoot);
  const state = manager.readState();
  if (state.run_id !== runId || state.workflow_id !== 'computation') {
    return;
  }
  if (state.run_status !== 'idle') {
    return;
  }
  manager.transitionStatus(state, 'running', {
    notes: `planning activated: ${runId}`,
    details: { source: 'orch_run_plan_computation' },
    eventType: 'planning_started',
  });
}

/** Shared compiled-plan summary used by both the dry_run and the A3-off "planned" outcomes. */
function buildPlanSummary(prepared: PreparedManifest): {
  manifest_path: string;
  manifest_sha256: string;
  workspace_dir: string;
  step_order: string[];
  steps: Array<{ id: string; tool: PreparedManifest['steps'][number]['tool']; script: string; command: string[]; expected_outputs: string[] }>;
} {
  return {
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

export async function bridgeStagedIdeaToComputation(
  input: ComputeBridgeInput,
): Promise<ComputeBridgeResult> {
  const executionPlan = compileExecutionPlan(input.runId, input.stagedIdea);
  const planPath = executionPlanArtifactPath(input.runDir);
  writeJsonAtomic(planPath, executionPlan);
  const { manifestPath } = materializeExecutionPlan(input.runDir, executionPlan, {
    methodSpec: input.stagedIdea.hints?.method_spec ?? null,
  });
  const prepared = prepareManifest({
    dryRun: input.dryRun,
    manifestPath,
    projectRoot: input.projectRoot,
    runDir: input.runDir,
    runId: input.runId,
  });
  ensurePlanningRunIsActive(input.projectRoot, input.runId);
  const result: ExecuteComputationManifestResult | PlannedExecutionResult = input.dryRun
    ? {
      status: 'dry_run',
      validated: true,
      dry_run: true,
      ...buildPlanSummary(prepared),
    }
    : (ensureA3Approval(input.projectRoot, prepared) ?? {
      // A3 (compute_runs) is opt-out by default (or already satisfied), so there is no
      // approval pause. The bridge is planning-only: hand back the staged manifest and
      // let the caller proceed with orch_run_execute_manifest.
      status: 'planned',
      dry_run: false,
      requires_approval: false,
      message: 'A3 (compute_runs) approval is not pending (gate disabled by policy or already satisfied); manifest is staged — execute via orch_run_execute_manifest.',
      ...buildPlanSummary(prepared),
    });
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
