import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { invalidParams } from '@nullius/shared';
import { prepareManifest } from './manifest.js';
import { ensureA3Approval } from './approval.js';
import { stampComputationLaunch } from './launch-stamp.js';
import { isInsideStampableRoot } from '../run-stamp.js';
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
  // Inside a stampable run root, a run's directory basename IS its identity:
  // the traceability read model scans directories by name and the launch
  // stamp derives its ledger run id from the basename, while the execution
  // result carries the supplied runId. Letting them differ there splits one
  // run into two identities (a stamp for one name, results under another),
  // so the mismatch is refused before anything happens — dry-run included,
  // validation being exactly what dry-run is for. OUTSIDE the run roots
  // (the MCP surface's free-location workspaces) no stamp is taken, no
  // directory-scan identity exists, and the names may legitimately differ.
  // Root membership uses the SAME symlink-resolved predicate as the stamp
  // containment — two resolution semantics would let an aliased project
  // root stamp a directory this check called outside.
  const runDirBasename = path.basename(path.resolve(input.runDir));
  if (isInsideStampableRoot(input.projectRoot, input.runDir) && runDirBasename !== input.runId) {
    throw invalidParams(
      'run_id must equal the run directory basename inside a run root (one run, one identity)',
      {
        run_id: input.runId,
        run_dir_basename: runDirBasename,
      },
    );
  }
  if (input.dryRun) {
    return dryRunResult(input);
  }
  const prepared = prepareManifest(input);
  const approval = ensureA3Approval(input.projectRoot, prepared);
  if (approval) {
    return approval;
  }
  // Manifest preflight BEFORE any capture: a non-zero exit means the entry
  // source cannot even load — broken-at-parse code must never enter the
  // ledger, and the two field voids of the stamp-predates-source class are
  // exactly what this gate prevents.
  runManifestPreflight(prepared);
  // Origin stamp at launch: approval has cleared and the next thing that
  // happens is execution, so the tree captured here IS the code that
  // produces the results. Never blocks the run (see launch-stamp.ts) with
  // ONE deliberate exception: relaunching a COMPLETED run under a changed
  // tree is refused — that overwrite is content territory.
  const originStamp = stampComputationLaunch(input.projectRoot, input.runDir);
  if (originStamp.status === 'refused_relaunch') {
    throw invalidParams(originStamp.detail, {
      validation_layer: 'attempt_boundary',
      run_id: input.runId,
    });
  }
  const result = await runPreparedManifest(input.projectRoot, prepared);
  return { ...result, origin_stamp: originStamp };
}

/** Manifest-declared preflight: an argv template whose `{entry}` token is
 *  substituted with the resolved entry-point path, run in the workspace.
 *  Generic by construction — the project supplies the interpreter/loader
 *  command; the front door only enforces "exit 0 or nothing gets stamped". */
function runManifestPreflight(prepared: {
  manifest: { preflight?: string[] };
  entryPointScriptPath: string;
  workspaceDir: string;
}): void {
  const template = prepared.manifest.preflight;
  if (!template || template.length === 0) return;
  const argv = template.map(part => part.split('{entry}').join(prepared.entryPointScriptPath));
  const result = spawnSync(argv[0]!, argv.slice(1), {
    cwd: prepared.workspaceDir,
    encoding: 'utf-8',
    timeout: 300_000,
  });
  if (result.error || result.status !== 0) {
    const detail = result.error
      ? result.error.message
      : `${(result.stderr || result.stdout || '').trim().split('\n').slice(-3).join(' | ')}`;
    throw invalidParams(
      `manifest preflight refused the entry source (exit ${result.status ?? 'spawn-error'}): ${detail || 'no output'}`,
      { validation_layer: 'preflight', preflight: argv },
    );
  }
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
