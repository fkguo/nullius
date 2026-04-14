import * as path from 'node:path';
import type { ComputationManifestV1, ComputationResultV1 } from '@autoresearch/shared';
import {
  computeSignalKey,
  createMemoryGraph,
} from '@autoresearch/shared';
import { makeRunArtifactUri } from './artifact-refs.js';

function memoryGraphDbPath(projectRoot: string): string {
  return path.join(projectRoot, '.autoresearch', 'memory-graph.sqlite');
}

function dependencySignals(manifest: ComputationManifestV1): string[] {
  const signals: string[] = [];
  const dependencies = manifest.dependencies ?? {};
  for (const pkg of dependencies.mathematica_packages ?? []) {
    signals.push(`package:mathematica:${pkg}`);
  }
  for (const pkg of dependencies.julia_packages ?? []) {
    signals.push(`package:julia:${pkg}`);
  }
  for (const pkg of dependencies.python_packages ?? []) {
    signals.push(`package:python:${pkg}`);
  }
  return signals;
}

async function recordBoundary(params: {
  projectRoot: string;
  runId: string;
  signals: string[];
  geneId: string;
  success: boolean;
  reason?: string;
  detailsArtifactUri?: string | null;
  qualityScore?: number;
}): Promise<void> {
  const graph = createMemoryGraph({ dbPath: memoryGraphDbPath(params.projectRoot) });
  const signalKey = computeSignalKey(params.signals);
  await graph.recordSignalSnapshot(params.runId, params.signals);
  await graph.recordOutcome(params.runId, params.geneId, {
    signal_key: signalKey,
    success: params.success,
    ...(params.reason ? { reason: params.reason } : {}),
    ...(params.detailsArtifactUri ? { details_artifact_uri: params.detailsArtifactUri } : {}),
    ...(params.qualityScore !== undefined ? { quality_score: params.qualityScore } : {}),
    validation_passed: params.success,
  });
  await graph.aggregateEdges();
}

export async function recordComputationResultToMemoryGraph(params: {
  projectRoot: string;
  manifest: ComputationManifestV1;
  computationResult: ComputationResultV1;
}): Promise<void> {
  const result = params.computationResult;
  const signals = [
    'boundary:compute_result',
    `execution_status:${result.execution_status}`,
    `feedback_signal:${result.feedback_lowering.signal}`,
    `decision_kind:${result.feedback_lowering.decision_kind}`,
    ...dependencySignals(params.manifest),
  ];
  if (result.failure_reason) {
    signals.push(`failure_reason:${result.failure_reason}`);
  }
  await recordBoundary({
    projectRoot: params.projectRoot,
    runId: result.run_id,
    signals,
    geneId: `boundary:compute_result:${result.execution_status}`,
    success: result.execution_status === 'completed',
    reason: result.failure_reason ?? result.summary,
    detailsArtifactUri: makeRunArtifactUri(result.run_id, 'artifacts/computation_result_v1.json'),
    qualityScore: result.execution_status === 'completed' ? 1 : 0,
  });
}

export async function recordVerificationToMemoryGraph(params: {
  projectRoot: string;
  runId: string;
  status: 'passed' | 'failed' | 'blocked';
  summary: string;
  checkRunUri: string;
}): Promise<void> {
  await recordBoundary({
    projectRoot: params.projectRoot,
    runId: params.runId,
    signals: [
      'boundary:verification',
      'check_kind:decisive_verification',
      `verification_status:${params.status}`,
      params.summary,
    ],
    geneId: `boundary:verification:${params.status}`,
    success: params.status === 'passed',
    reason: params.summary,
    detailsArtifactUri: params.checkRunUri,
    qualityScore: params.status === 'passed' ? 1 : 0,
  });
}

export async function recordFinalConclusionsToMemoryGraph(params: {
  projectRoot: string;
  runId: string;
  approvalId: string;
  finalConclusionsUri: string;
  summary: string;
}): Promise<void> {
  await recordBoundary({
    projectRoot: params.projectRoot,
    runId: params.runId,
    signals: [
      'boundary:final_conclusions',
      'gate:A5',
      `approval_id:${params.approvalId}`,
      'final_conclusions_status:approved',
      params.summary,
    ],
    geneId: 'boundary:final_conclusions:A5',
    success: true,
    reason: params.summary,
    detailsArtifactUri: params.finalConclusionsUri,
    qualityScore: 1,
  });
}
