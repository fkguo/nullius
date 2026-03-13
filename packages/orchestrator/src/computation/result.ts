import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ArtifactRefV1, ComputationResultV1 } from '@autoresearch/shared';
import { createRunArtifactRef } from './artifact-refs.js';
import { assertExecutionPlanValid } from './execution-plan.js';
import { planComputationFollowupBridges, writeComputationFollowupBridgeArtifacts } from './followup-bridges.js';
import { writeJsonAtomic } from './io.js';
import { deriveFeedbackLowering, deriveNextIdeaLoopState } from './loop-feedback.js';
import { assertComputationResultValid } from './result-schema.js';
import { deriveFeedbackSignal } from './result-signal.js';
import type { ExecutionStatusFile, PreparedManifest } from './types.js';

function listFilesRecursive(dirPath: string): string[] {
  if (!fs.existsSync(dirPath)) return [];
  const entries = fs.readdirSync(dirPath, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      files.push(...listFilesRecursive(fullPath));
      continue;
    }
    files.push(fullPath);
  }
  return files;
}

function buildSummary(status: ExecutionStatusFile, producedCount: number): string {
  if (status.status === 'completed') {
    return `Approved execution completed ${status.steps.length} step(s) and produced ${producedCount} declared output artifact(s).`;
  }
  const failedStep = status.steps.find(step => step.status === 'failed');
  const completedSteps = status.steps.filter(step => step.status === 'completed').length;
  return `Approved execution failed at ${failedStep?.id ?? 'an unknown step'} after ${completedSteps}/${status.steps.length} completed step(s).`;
}

function loadExecutionPlanTitle(prepared: PreparedManifest): string {
  const planPath = path.join(prepared.workspaceDir, 'execution_plan_v1.json');
  if (!fs.existsSync(planPath)) {
    return prepared.manifest.title ?? `Approved computation for ${prepared.runId}`;
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(planPath, 'utf-8')) as unknown;
    return assertExecutionPlanValid(parsed).objective;
  } catch {
    return prepared.manifest.title ?? `Approved computation for ${prepared.runId}`;
  }
}

function collectProducedArtifactRefs(params: {
  prepared: PreparedManifest;
  statusPath: string;
  logsDir: string;
  producedOutputs: string[];
}): ArtifactRefV1[] {
  const files = [
    params.statusPath,
    ...params.producedOutputs.filter(filePath => fs.existsSync(filePath)).sort(),
    ...listFilesRecursive(params.logsDir),
  ];
  const seen = new Set<string>();
  return files
    .filter(filePath => {
      if (seen.has(filePath)) return false;
      seen.add(filePath);
      return true;
    })
    .map(filePath => createRunArtifactRef(
      params.prepared.runId,
      params.prepared.runDir,
      filePath,
      filePath === params.statusPath
        ? 'execution_status'
        : filePath.startsWith(params.logsDir)
          ? 'execution_log'
          : 'structured_result',
    ));
}

export function writeComputationResultArtifact(params: {
  prepared: PreparedManifest;
  status: ExecutionStatusFile;
  statusPath: string;
  logsDir: string;
  producedOutputs: string[];
  failureReason?: string;
}): {
  computationResult: ComputationResultV1;
  computationResultPath: string;
  computationResultRef: ArtifactRefV1;
} {
  if (params.status.status === 'running' || !params.status.completed_at) {
    throw new Error('computation result can only be written after execution reaches a terminal state');
  }
  const manifestRef = createRunArtifactRef(
    params.prepared.runId,
    params.prepared.runDir,
    params.prepared.manifestPath,
    'computation_manifest',
  );
  const producedArtifactRefs = collectProducedArtifactRefs(params);
  const objectiveTitle = loadExecutionPlanTitle(params.prepared);
  const summary = buildSummary(params.status, params.producedOutputs.length);
  const computationResultPath = path.join(params.prepared.runDir, 'artifacts', 'computation_result_v1.json');
  const feedbackLowering = deriveFeedbackLowering({
    runId: params.prepared.runId,
    executionStatus: params.status.status,
    signal: deriveFeedbackSignal({
      executionStatus: params.status.status,
      producedOutputs: params.producedOutputs,
    }),
  });
  const baseResult = {
    schema_version: 1 as const,
    run_id: params.prepared.runId,
    objective_title: objectiveTitle,
    manifest_ref: manifestRef,
    execution_status: params.status.status,
    produced_artifact_refs: producedArtifactRefs,
    started_at: params.status.started_at,
    finished_at: params.status.completed_at,
    summary,
    feedback_lowering: feedbackLowering,
    executor_provenance: {
      orchestrator_component: '@autoresearch/orchestrator',
      execution_surface: 'computation_manifest_executor',
      approval_gate: 'A3' as const,
      step_tools: [...new Set(params.prepared.steps.map(step => step.tool))],
      step_ids: [...params.prepared.stepOrder],
    },
    ...(params.failureReason ? { failure_reason: params.failureReason } : {}),
  };
  const followupBridges = planComputationFollowupBridges(params.prepared.runDir, baseResult);
  const { workspaceFeedback, nextActions } = deriveNextIdeaLoopState(baseResult, followupBridges.writingSeed);
  const followupBridgeRefs = writeComputationFollowupBridgeArtifacts(
    params.prepared.runId,
    params.prepared.runDir,
    followupBridges.bridgePlans,
  );
  const computationResult = assertComputationResultValid({
    ...baseResult,
    next_actions: nextActions,
    followup_bridge_refs: followupBridgeRefs,
    workspace_feedback: workspaceFeedback,
  });
  writeJsonAtomic(computationResultPath, computationResult);
  return {
    computationResult,
    computationResultPath,
    computationResultRef: createRunArtifactRef(
      params.prepared.runId,
      params.prepared.runDir,
      computationResultPath,
      'computation_result',
    ),
  };
}
