import * as path from 'node:path';
import { invalidParams } from '@autoresearch/shared';
import {
  executeComputationManifest,
  planComputationFromRunDir,
  stageContentInRunDir,
  stageIdeaArtifactsIntoRunFromPath,
} from '../computation/index.js';

function resolvePathWithinParent(parentDir: string, candidatePath: string, field: string): string {
  const resolvedParent = path.resolve(parentDir);
  const resolved = path.isAbsolute(candidatePath)
    ? path.resolve(candidatePath)
    : path.resolve(resolvedParent, candidatePath);
  const relative = path.relative(resolvedParent, resolved);
  if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))) {
    return resolved;
  }
  throw invalidParams(`${field} must be within ${resolvedParent}`, {
    field,
    parent_dir: resolvedParent,
    candidate: candidatePath,
  });
}

export async function handleOrchRunStageIdea(params: {
  run_id: string;
  run_dir: string;
  handoff_path: string;
  handoff_uri?: string;
}) {
  const staged = stageIdeaArtifactsIntoRunFromPath({
    handoffPath: params.handoff_path,
    handoffUri: params.handoff_uri,
    runDir: params.run_dir,
  });
  return {
    status: 'staged',
    run_id: params.run_id,
    run_dir: params.run_dir,
    outline_seed_path: path.relative(params.run_dir, staged.outlineSeedPath).split(path.sep).join('/'),
    hints_snapshot_path: path.relative(params.run_dir, staged.hintsSnapshotPath).split(path.sep).join('/'),
    next_actions: [
      {
        tool: 'orch_run_plan_computation',
        reason: 'Compile the staged outline seed and hints into execution_plan_v1.json and computation/manifest.json before any execution.',
      },
    ],
  };
}

export async function handleOrchRunStageContent(params: {
  run_id: string;
  run_dir: string;
  content_type: 'section_output' | 'outline_plan' | 'paperset_curation' | 'revision_plan' | 'reviewer_report' | 'judge_decision';
  content: string;
  artifact_suffix?: string;
  task_id?: string;
  task_kind?: 'draft_update' | 'review';
}) {
  return stageContentInRunDir({
    runId: params.run_id,
    runDir: params.run_dir,
    contentType: params.content_type,
    content: params.content,
    artifactSuffix: params.artifact_suffix,
    taskId: params.task_id,
    taskKind: params.task_kind,
  });
}

export async function handleOrchRunPlanComputation(params: {
  project_root: string;
  run_id: string;
  run_dir: string;
  dry_run?: boolean;
}) {
  return planComputationFromRunDir({
    dryRun: params.dry_run,
    projectRoot: params.project_root,
    runDir: params.run_dir,
    runId: params.run_id,
  });
}

export async function handleOrchRunExecuteManifest(params: {
  project_root: string;
  run_id: string;
  run_dir: string;
  manifest_path: string;
  dry_run?: boolean;
}) {
  const manifestPath = resolvePathWithinParent(params.run_dir, params.manifest_path, 'manifest_path');
  resolvePathWithinParent(path.join(params.run_dir, 'computation'), manifestPath, 'manifest_path');
  return executeComputationManifest({
    dryRun: params.dry_run,
    manifestPath,
    projectRoot: params.project_root,
    runDir: params.run_dir,
    runId: params.run_id,
  });
}
