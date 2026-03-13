import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ArtifactRefV1, ComputationResultV1 } from '@autoresearch/shared';
import { createRunArtifactRef, makeRunArtifactUri } from './artifact-refs.js';
import { writeJsonAtomic } from './io.js';
import { buildLoopFeedback } from './loop-feedback.js';
import { assertComputationResultValid } from './result-schema.js';
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
  const summary = buildSummary(params.status, params.producedOutputs.length);
  const computationResultPath = path.join(params.prepared.runDir, 'artifacts', 'computation_result_v1.json');
  const outcomeUri = makeRunArtifactUri(params.prepared.runId, 'artifacts/computation_result_v1.json');
  const { workspaceFeedback, nextActions } = buildLoopFeedback({
    prepared: params.prepared,
    executionStatus: params.status.status,
    summary,
    manifestRef,
    outcomeUri,
    producedArtifactRefs,
    failureReason: params.failureReason,
  });
  const computationResult = assertComputationResultValid({
    schema_version: 1,
    run_id: params.prepared.runId,
    manifest_ref: manifestRef,
    execution_status: params.status.status,
    produced_artifact_refs: producedArtifactRefs,
    started_at: params.status.started_at,
    finished_at: params.status.completed_at,
    summary,
    next_actions: nextActions,
    executor_provenance: {
      orchestrator_component: '@autoresearch/orchestrator',
      execution_surface: 'computation_manifest_executor',
      approval_gate: 'A3',
      step_tools: [...new Set(params.prepared.steps.map(step => step.tool))],
      step_ids: [...params.prepared.stepOrder],
    },
    ...(params.failureReason ? { failure_reason: params.failureReason } : {}),
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
