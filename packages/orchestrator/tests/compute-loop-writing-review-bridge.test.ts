import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { executeComputationManifest } from '../src/computation/index.js';
import { compileExecutionPlan } from '../src/computation/execution-plan.js';
import { executionPlanArtifactPath, materializeExecutionPlan } from '../src/computation/materialize-execution-plan.js';
import {
  cleanupRegisteredDirs,
  initRunState,
  makeTmpDir,
  markA3Satisfied,
  registerCleanup,
  writeJson,
} from './executeManifestTestUtils.js';

afterEach(() => {
  cleanupRegisteredDirs();
});

function createBridgeRun(runId: string, projectRoot: string) {
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

function stageContextArtifact(runDir: string, contentType: 'section_output' | 'reviewer_report' | 'revision_plan', suffix: string): void {
  const artifactPath = path.join(runDir, 'artifacts', `staged_${contentType}_${suffix}.json`);
  writeJson(artifactPath, {
    version: 1,
    staged_at: '2026-03-13T00:00:00Z',
    content_type: contentType,
    content: JSON.stringify({ section_number: '1', title: 'Seed context', content: 'Seed content' }),
  });
}

function readOutcome(runDir: string) {
  return JSON.parse(
    fs.readFileSync(path.join(runDir, 'artifacts', 'computation_result_v1.json'), 'utf-8'),
  ) as {
    followup_bridge_refs: Array<{ uri: string }>;
    workspace_feedback: {
      tasks: Array<{ kind: string; status: string }>;
      handoffs: Array<{ handoff_kind: string; payload: Record<string, unknown> }>;
    };
  };
}

describe('compute-loop writing/review bridges', () => {
  it('creates a writing bridge and draft_update follow-up without fabricating a review loop', async () => {
    const projectRoot = makeTmpDir();
    const runId = 'run-writing-bridge';
    registerCleanup(projectRoot);

    const { runDir, manifestPath } = createBridgeRun(runId, projectRoot);
    const manager = initRunState(projectRoot, runId);
    markA3Satisfied(manager, 'A3-0001');

    const result = await executeComputationManifest({ manifestPath, projectRoot, runDir, runId });
    expect(result.status).toBe('completed');
    expect(result.followup_bridge_refs).toHaveLength(1);

    const outcome = readOutcome(runDir);
    expect(outcome.followup_bridge_refs).toHaveLength(1);
    expect(outcome.workspace_feedback.tasks.some(task => task.kind === 'draft_update' && task.status === 'pending')).toBe(true);
    expect(outcome.workspace_feedback.tasks.some(task => task.kind === 'review')).toBe(false);
    expect(outcome.workspace_feedback.handoffs).toHaveLength(0);

    const writingBridge = JSON.parse(
      fs.readFileSync(path.join(runDir, 'artifacts', 'writing_followup_bridge_v1.json'), 'utf-8'),
    ) as {
      bridge_kind: string;
      context: { draft_context_mode: string };
      target: { task_kind: string; suggested_content_type: string; seed_payload: { finding_node_ids: string[] } };
      handoff?: unknown;
    };
    expect(writingBridge.bridge_kind).toBe('writing');
    expect(writingBridge.context.draft_context_mode).toBe('seeded_draft');
    expect(writingBridge.target.task_kind).toBe('draft_update');
    expect(writingBridge.target.suggested_content_type).toBe('section_output');
    expect(writingBridge.target.seed_payload.finding_node_ids).toEqual([`finding:${runId}`]);
    expect(writingBridge.handoff).toBeUndefined();
  });

  it('creates writing and review handoffs only when staged draft context already exists', async () => {
    const projectRoot = makeTmpDir();
    const runId = 'run-writing-review-bridge';
    registerCleanup(projectRoot);

    const { runDir, manifestPath } = createBridgeRun(runId, projectRoot);
    stageContextArtifact(runDir, 'section_output', 'draft_seed');
    stageContextArtifact(runDir, 'reviewer_report', 'review_seed');
    const manager = initRunState(projectRoot, runId);
    markA3Satisfied(manager, 'A3-0001');

    const result = await executeComputationManifest({ manifestPath, projectRoot, runDir, runId });
    expect(result.status).toBe('completed');
    expect(result.followup_bridge_refs).toHaveLength(2);

    const outcome = readOutcome(runDir);
    expect(outcome.workspace_feedback.tasks.some(task => task.kind === 'draft_update' && task.status === 'pending')).toBe(true);
    expect(outcome.workspace_feedback.tasks.some(task => task.kind === 'review' && task.status === 'pending')).toBe(true);
    expect(outcome.workspace_feedback.handoffs.map(handoff => handoff.handoff_kind)).toEqual(['writing', 'review']);

    const writingBridge = JSON.parse(
      fs.readFileSync(path.join(runDir, 'artifacts', 'writing_followup_bridge_v1.json'), 'utf-8'),
    ) as {
      context: { draft_context_mode: string; draft_source_artifact_name: string };
      handoff?: { handoff_kind: string };
    };
    const reviewBridge = JSON.parse(
      fs.readFileSync(path.join(runDir, 'artifacts', 'review_followup_bridge_v1.json'), 'utf-8'),
    ) as {
      bridge_kind: string;
      context: { review_source_artifact_name?: string };
      target: { suggested_content_type: string };
      handoff: { handoff_kind: string };
    };
    expect(writingBridge.context.draft_context_mode).toBe('existing_draft');
    expect(writingBridge.context.draft_source_artifact_name).toContain('staged_section_output');
    expect(writingBridge.handoff?.handoff_kind).toBe('writing');
    expect(reviewBridge.bridge_kind).toBe('review');
    expect(reviewBridge.context.review_source_artifact_name).toContain('staged_reviewer_report');
    expect(reviewBridge.target.suggested_content_type).toBe('reviewer_report');
    expect(reviewBridge.handoff.handoff_kind).toBe('review');
  });
});
