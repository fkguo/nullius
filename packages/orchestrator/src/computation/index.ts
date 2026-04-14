import { prepareManifest } from './manifest.js';
import { ensureA3Approval } from './approval.js';
import { runPreparedManifest } from './runner.js';
import type {
  DryRunExecutionResult,
  ExecuteComputationManifestInput,
  ExecuteComputationManifestResult,
} from './types.js';
import { bridgeStagedIdeaToComputation } from './bridge.js';
import { loadStagedIdeaSurfaceFromRunDir } from './staged-idea-artifacts.js';

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

export async function planComputationFromRunDir(input: {
  projectRoot: string;
  runId: string;
  runDir: string;
  dryRun?: boolean;
}) {
  const stagedIdea = loadStagedIdeaSurfaceFromRunDir(input.runDir);
  return bridgeStagedIdeaToComputation({
    dryRun: input.dryRun,
    projectRoot: input.projectRoot,
    runDir: input.runDir,
    runId: input.runId,
    stagedIdea,
  });
}

export { bridgeStagedIdeaToComputation, type ComputeBridgeInput, type ComputeBridgeResult } from './bridge.js';
export {
  extractIdeaStagingHints,
  parseIdeaHandoffRecord,
  readIdeaHandoffRecord,
  stageIdeaArtifactsIntoRun,
  stageIdeaArtifactsIntoRunFromPath,
  type StagedIdeaHintsSnapshotV1,
} from './staged-idea-artifacts.js';
export { loadStagedIdeaSurfaceFromRunDir } from './staged-idea-artifacts.js';
export {
  createStagedContentArtifactRef,
  readStagedContentArtifactFromRunDir,
  stageContentInRunDir,
} from './staged-content.js';
export {
  buildTeamConfigForDelegatedFollowupTask,
  primeDelegatedFollowupTeamState,
  attachDelegatedFollowupTeamExecutionMetadata,
  type DelegatedFollowupTeamConfig,
} from './feedback-followups.js';
export {
  hasCompletedDelegatedFeedbackAssignmentForTask,
  selectDelegatedFeedbackFollowupTask,
  type DelegatedFeedbackFollowupTask,
} from './feedback-followup-selection.js';
export {
  progressDelegatedFeedbackFollowups,
  type FeedbackFollowupLaunchResult,
  type FeedbackFollowupLaunchStatus,
} from './feedback-followup-progression.js';
export {
  progressRunFollowups,
  type ProgressFollowupsBranch,
  type ProgressFollowupsResult,
  type ProgressFollowupsStatus,
} from './progress-followups.js';
export {
  hasCompletedDelegatedFollowupAssignmentForTask,
  selectDelegatedComputationFollowupTask,
  type DelegatedComputationFollowupTask,
} from './delegated-followup-selection.js';
export {
  progressDelegatedComputationFollowups,
  type DelegatedComputationFollowupLaunchResult,
} from './delegated-followup-progression.js';
export type {
  DelegatedComputationFollowupLaunchStatus,
} from './delegated-followup-progression.js';
export {
  evaluateReviewFollowupGate,
  type ReviewFollowupGateDecision,
  type ReviewFollowupGateResult,
} from './review-followup-gate.js';
export {
  buildFollowupRuntimePrompt,
  DEFAULT_FOLLOWUP_RUNTIME_MODEL,
  FEEDBACK_FOLLOWUP_RUNTIME_TOOLS,
  WRITING_REVIEW_FOLLOWUP_RUNTIME_TOOLS,
  followupRuntimeToolsForTaskKind,
} from './followup-runtime.js';
export type {
  ExecuteComputationManifestInput,
  ExecuteComputationManifestResult,
} from './types.js';
