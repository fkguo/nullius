import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { executeComputationManifest } from '../src/computation/index.js';
import { compileExecutionPlan } from '../src/computation/execution-plan.js';
import { executionPlanArtifactPath, materializeExecutionPlan } from '../src/computation/materialize-execution-plan.js';
import { deriveNextIdeaLoopState } from '../src/computation/loop-feedback.js';
import { assertComputationResultValid } from '../src/computation/result-schema.js';
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
      thesis: 'Deterministic failed execution should lower into idea refinement.',
      claims: [{ claim_text: 'Claim A' }],
      hypotheses: ['Hypothesis A'],
      source_handoff_uri: '/tmp/idea-handoff.json',
    },
    hints: {
      minimal_compute_plan: [{ step: 'Fail the bridge task', method: 'generic execution', estimated_difficulty: 'low' }],
    },
  });
  writeJson(executionPlanArtifactPath(runDir), executionPlan);
  const { manifestPath } = materializeExecutionPlan(runDir, executionPlan);
  return { runDir, manifestPath };
}

function writeFeedbackSignalRunner(runDir: string, feedbackSignal: 'success' | 'weak_signal'): void {
  fs.writeFileSync(
    path.join(runDir, 'computation', 'scripts', 'execution_plan_runner.py'),
    [
      'import argparse',
      'import json',
      'from pathlib import Path',
      '',
      "parser = argparse.ArgumentParser()",
      "parser.add_argument('--task-id', required=True)",
      "parser.add_argument('--execution-plan', required=True)",
      'args = parser.parse_args()',
      '',
      "payload = {'feedback_signal': '" + feedbackSignal + "', 'task_id': args.task_id}",
      "output_path = Path('outputs') / f\"{args.task_id}.json\"",
      'output_path.parent.mkdir(parents=True, exist_ok=True)',
      "output_path.write_text(json.dumps(payload) + '\\n', encoding='utf-8')",
    ].join('\n'),
    'utf-8',
  );
}

describe('compute-loop failure lowering', () => {
  it('writes a failed computation_result_v1 artifact and feedback handoff without emitting a false finding', async () => {
    const projectRoot = makeTmpDir();
    const runId = 'run-loop-failure';
    registerCleanup(projectRoot);

    const { runDir, manifestPath } = createBridgeRun(runId, projectRoot);
    fs.writeFileSync(
      path.join(runDir, 'computation', 'scripts', 'execution_plan_runner.py'),
      "raise SystemExit(1)\n",
      'utf-8',
    );
    const manager = initRunState(projectRoot, runId);
    markA3Satisfied(manager, 'A3-0001');

    const result = await executeComputationManifest({
      manifestPath,
      projectRoot,
      runDir,
      runId,
    });

    expect(result.status).toBe('failed');
    expect(fs.existsSync(result.artifact_paths.computation_result)).toBe(true);
    expect(result.next_actions[0]?.action_kind).toBe('downgrade_idea');
    expect(result.next_actions[0]?.task_kind).toBe('idea');
    expect(result.next_actions[0]?.handoff_kind).toBe('feedback');

    const outcome = JSON.parse(fs.readFileSync(result.artifact_paths.computation_result, 'utf-8')) as {
      execution_status: string;
      failure_reason?: string;
      feedback_lowering: {
        signal: string;
        decision_kind: string;
        priority_change: string;
        prune_candidate: boolean;
      };
      workspace_feedback: {
        workspace: { edges: Array<{ kind: string; to_node_id: string }> };
        tasks: Array<{ kind: string; status: string }>;
        handoffs: Array<{
          handoff_kind: string;
          payload: { disposition: string; feedback_signal: string; priority_change: string; prune_candidate: boolean };
        }>;
      };
    };

    expect(outcome.execution_status).toBe('failed');
    expect(outcome.failure_reason).toContain("step 'task_001' exited with code 1");
    expect(outcome.feedback_lowering.signal).toBe('failure');
    expect(outcome.feedback_lowering.decision_kind).toBe('downgrade_idea');
    expect(outcome.feedback_lowering.priority_change).toBe('lower');
    expect(outcome.feedback_lowering.prune_candidate).toBe(true);
    expect(outcome.workspace_feedback.workspace.edges.some(edge => edge.kind === 'backtracks_to' && edge.to_node_id === `idea:${runId}`)).toBe(true);
    expect(outcome.workspace_feedback.tasks.some(task => task.kind === 'compute' && task.status === 'blocked')).toBe(true);
    expect(outcome.workspace_feedback.tasks.some(task => task.kind === 'idea' && task.status === 'pending')).toBe(true);
    expect(outcome.workspace_feedback.tasks.some(task => task.kind === 'finding')).toBe(false);
    expect(outcome.workspace_feedback.handoffs).toHaveLength(1);
    expect(outcome.workspace_feedback.handoffs[0]?.handoff_kind).toBe('feedback');
    expect(outcome.workspace_feedback.handoffs[0]?.payload.disposition).toBe('downgrade_idea');
    expect(outcome.workspace_feedback.handoffs[0]?.payload.feedback_signal).toBe('failure');
    expect(outcome.workspace_feedback.handoffs[0]?.payload.priority_change).toBe('lower');
    expect(outcome.workspace_feedback.handoffs[0]?.payload.prune_candidate).toBe(true);
  });

  it('re-ingests a completed weak-signal computation_result_v1 into the same provider-neutral idea-branch lowering', async () => {
    const projectRoot = makeTmpDir();
    const runId = 'run-loop-weak-signal';
    registerCleanup(projectRoot);

    const { runDir, manifestPath } = createBridgeRun(runId, projectRoot);
    writeFeedbackSignalRunner(runDir, 'weak_signal');
    const manager = initRunState(projectRoot, runId);
    markA3Satisfied(manager, 'A3-0001');

    const result = await executeComputationManifest({
      manifestPath,
      projectRoot,
      runDir,
      runId,
    });

    expect(result.status).toBe('completed');
    expect(result.next_actions[0]?.action_kind).toBe('branch_idea');
    expect(result.next_actions[0]?.task_kind).toBe('idea');
    expect(result.next_actions[0]?.handoff_kind).toBe('feedback');

    const stored = assertComputationResultValid(
      JSON.parse(fs.readFileSync(result.artifact_paths.computation_result, 'utf-8')) as unknown,
    );
    expect(stored.feedback_lowering.signal).toBe('weak_signal');
    expect(stored.feedback_lowering.decision_kind).toBe('branch_idea');
    expect(stored.feedback_lowering.priority_change).toBe('keep');
    expect(stored.feedback_lowering.prune_candidate).toBe(false);
    expect(stored.workspace_feedback.tasks.some(task => task.kind === 'compute' && task.status === 'completed')).toBe(true);
    expect(stored.workspace_feedback.tasks.some(task => task.kind === 'idea' && task.status === 'pending')).toBe(true);
    expect(stored.workspace_feedback.tasks.some(task => task.kind === 'finding')).toBe(false);
    expect(stored.workspace_feedback.workspace.nodes.some(node => node.node_id === `idea-branch:${runId}`)).toBe(true);
    expect(stored.workspace_feedback.workspace.edges.some(edge => edge.kind === 'branches_to' && edge.to_node_id === `idea-branch:${runId}`)).toBe(true);
    expect(stored.workspace_feedback.handoffs[0]?.payload.disposition).toBe('branch_idea');

    const replayed = deriveNextIdeaLoopState(stored);
    expect(replayed.nextActions).toEqual(stored.next_actions);
    expect(replayed.workspaceFeedback.tasks.map(task => ({ kind: task.kind, status: task.status, target: task.target_node_id }))).toEqual(
      stored.workspace_feedback.tasks.map(task => ({ kind: task.kind, status: task.status, target: task.target_node_id })),
    );
    expect(replayed.workspaceFeedback.handoffs.map(handoff => ({ kind: handoff.handoff_kind, target: handoff.target_node_id, payload: handoff.payload }))).toEqual(
      stored.workspace_feedback.handoffs.map(handoff => ({ kind: handoff.handoff_kind, target: handoff.target_node_id, payload: handoff.payload })),
    );
  });
});
