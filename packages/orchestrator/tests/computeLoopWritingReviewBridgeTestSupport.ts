import * as fs from 'node:fs';
import * as path from 'node:path';

import { compileExecutionPlan } from '../src/computation/execution-plan.js';
import { executionPlanArtifactPath, materializeExecutionPlan } from '../src/computation/materialize-execution-plan.js';
import { stageContentInRunDir } from '../src/computation/staged-content.js';
import { writeJson } from './executeManifestTestUtils.js';

export function createBridgeRun(runId: string, projectRoot: string) {
  const runDir = path.join(projectRoot, runId);
  fs.mkdirSync(runDir, { recursive: true });
  const executionPlan = compileExecutionPlan(runId, {
    outline_seed_path: 'artifacts/outline_seed_v1.json',
    outline: {
      thesis: 'Computation result should bridge into writing and review substrate deterministically.',
      claims: [{ claim_text: 'Claim A' }],
      hypotheses: ['Hypothesis A'],
      source_handoff_uri: '/tmp/idea-handoff.json',
    },
    hints: {
      minimal_compute_plan: [{ step: 'Evaluate the writing bridge task', method: 'generic execution', estimated_difficulty: 'low' }],
    },
  });
  writeJson(executionPlanArtifactPath(runDir), executionPlan);
  const { manifestPath } = materializeExecutionPlan(runDir, executionPlan);
  return { runDir, manifestPath };
}

export function stageContextArtifact(
  runDir: string,
  contentType: 'section_output' | 'reviewer_report' | 'revision_plan',
  suffix: string,
  options?: {
    stagedAt?: string;
    content?: string;
    taskRef?: {
      taskId: string;
      taskKind: 'draft_update' | 'review';
    };
  },
): void {
  const staged = stageContentInRunDir({
    runId: path.basename(runDir),
    runDir,
    contentType,
    content: options?.content ?? JSON.stringify({ section_number: '1', title: 'Seed context', content: 'Seed content' }),
    artifactSuffix: suffix,
    taskId: options?.taskRef?.taskId,
    taskKind: options?.taskRef?.taskKind,
  });
  if (options?.stagedAt) {
    const artifactPath = path.join(runDir, 'artifacts', staged.artifact_name);
    const artifact = JSON.parse(fs.readFileSync(artifactPath, 'utf-8')) as Record<string, unknown>;
    artifact.staged_at = options.stagedAt;
    writeJson(artifactPath, artifact);
  }
}

export function textResponse(text: string) {
  return { model: 'claude-test', content: { type: 'text' as const, text }, stopReason: 'endTurn' };
}

export type ComputationOutcomeSnapshot = {
  followup_bridge_refs: Array<{ uri: string }>;
  workspace_feedback: {
    tasks: Array<{ task_id: string; kind: string; status: string; metadata?: Record<string, unknown> }>;
    handoffs: Array<{
      handoff_id: string;
      handoff_kind: string;
      workspace_id: string;
      source_task_id: string;
      payload: Record<string, unknown>;
    }>;
  };
};

export function readOutcome(runDir: string): ComputationOutcomeSnapshot {
  return JSON.parse(
    fs.readFileSync(path.join(runDir, 'artifacts', 'computation_result_v1.json'), 'utf-8'),
  ) as ComputationOutcomeSnapshot;
}
