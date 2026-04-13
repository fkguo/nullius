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

function readVerificationArtifacts(runDir: string) {
  const subjectPath = path.join(runDir, 'artifacts', 'verification_subject_computation_result_v1.json');
  const verdictPath = path.join(runDir, 'artifacts', 'verification_subject_verdict_computation_result_v1.json');
  const coveragePath = path.join(runDir, 'artifacts', 'verification_coverage_v1.json');
  return {
    subjectPath,
    verdictPath,
    coveragePath,
    subject: JSON.parse(fs.readFileSync(subjectPath, 'utf-8')) as {
      linked_identifiers?: Array<{ id_kind: string; id_value: string }>;
    },
    verdict: JSON.parse(fs.readFileSync(verdictPath, 'utf-8')) as {
      status: string;
      check_run_refs: unknown[];
      missing_decisive_checks: Array<{ check_kind: string; reason: string; priority: string }>;
    },
    coverage: JSON.parse(fs.readFileSync(coveragePath, 'utf-8')) as {
      summary: {
        subjects_total: number;
        subjects_verified: number;
        subjects_partial: number;
        subjects_failed: number;
        subjects_blocked: number;
        subjects_not_attempted: number;
      };
      missing_decisive_checks: Array<{ subject_id: string; check_kind: string; reason: string; priority: string }>;
    },
  };
}

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

    const outcome = assertComputationResultValid(
      JSON.parse(fs.readFileSync(result.artifact_paths.computation_result, 'utf-8')) as unknown,
    );

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
    const ideaTask = outcome.workspace_feedback.tasks.find(task => task.kind === 'idea')!;
    expect(ideaTask.metadata?.team_execution).toMatchObject({
      owner_role: 'lead',
      delegate_role: 'delegate',
      delegate_id: 'delegate-1',
      coordination_policy: 'supervised_delegate',
      handoff_kind: 'feedback',
      workspace_id: outcome.workspace_feedback.workspace.workspace_id,
      research_task_ref: {
        task_id: ideaTask.task_id,
        task_kind: 'idea',
        source_task_id: outcome.workspace_feedback.tasks.find(task => task.kind === 'compute')?.task_id,
      },
    });
    expect(outcome.verification_refs?.subject_refs).toHaveLength(1);
    expect(outcome.verification_refs?.subject_verdict_refs).toHaveLength(1);
    expect(outcome.verification_refs?.coverage_refs).toHaveLength(1);
    expect(outcome.verification_refs).not.toHaveProperty('check_run_refs');

    const verification = readVerificationArtifacts(runDir);
    expect(fs.existsSync(verification.subjectPath)).toBe(true);
    expect(fs.existsSync(verification.verdictPath)).toBe(true);
    expect(fs.existsSync(verification.coveragePath)).toBe(true);
    expect(verification.subject.linked_identifiers).toEqual([{
      id_kind: 'computation_result_uri',
      id_value: `rep://runs/${encodeURIComponent(runId)}/artifact/${encodeURIComponent('artifacts/computation_result_v1.json')}`,
    }]);
    expect(verification.verdict.status).toBe('blocked');
    expect(verification.verdict.check_run_refs).toEqual([]);
    expect(verification.verdict.missing_decisive_checks).toEqual([{
      check_kind: 'decisive_verification_pending',
      reason: 'Decisive verification is blocked by execution failure.',
      priority: 'high',
    }]);
    expect(verification.coverage.summary).toEqual({
      subjects_total: 1,
      subjects_verified: 0,
      subjects_partial: 0,
      subjects_failed: 0,
      subjects_blocked: 1,
      subjects_not_attempted: 0,
    });
    expect(verification.coverage.missing_decisive_checks).toHaveLength(1);
    expect(verification.coverage.missing_decisive_checks[0]).toMatchObject({
      subject_id: `result:${runId}:computation_result`,
      check_kind: 'decisive_verification_pending',
      reason: 'Decisive verification is blocked by execution failure.',
      priority: 'high',
    });
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
    const branchedIdeaTask = stored.workspace_feedback.tasks.find(task => task.kind === 'idea')!;
    expect(branchedIdeaTask.metadata?.team_execution).toMatchObject({
      handoff_kind: 'feedback',
      workspace_id: stored.workspace_feedback.workspace.workspace_id,
      research_task_ref: {
        task_id: branchedIdeaTask.task_id,
        task_kind: 'idea',
      },
    });
    expect(stored.verification_refs?.subject_refs).toHaveLength(1);
    expect(stored.verification_refs?.subject_verdict_refs).toHaveLength(1);
    expect(stored.verification_refs?.coverage_refs).toHaveLength(1);
    expect(stored.verification_refs).not.toHaveProperty('check_run_refs');

    const verification = readVerificationArtifacts(runDir);
    expect(fs.existsSync(verification.subjectPath)).toBe(true);
    expect(fs.existsSync(verification.verdictPath)).toBe(true);
    expect(fs.existsSync(verification.coveragePath)).toBe(true);
    expect(verification.verdict.status).toBe('not_attempted');
    expect(verification.verdict.check_run_refs).toEqual([]);
    expect(verification.verdict.missing_decisive_checks).toEqual([{
      check_kind: 'decisive_verification_pending',
      reason: 'Decisive verification has not been attempted yet.',
      priority: 'high',
    }]);
    expect(verification.coverage.summary).toEqual({
      subjects_total: 1,
      subjects_verified: 0,
      subjects_partial: 0,
      subjects_failed: 0,
      subjects_blocked: 0,
      subjects_not_attempted: 1,
    });
    expect(verification.coverage.missing_decisive_checks).toHaveLength(1);
    expect(verification.coverage.missing_decisive_checks[0]).toMatchObject({
      subject_id: `result:${runId}:computation_result`,
      check_kind: 'decisive_verification_pending',
      reason: 'Decisive verification has not been attempted yet.',
      priority: 'high',
    });

    const replayed = deriveNextIdeaLoopState(stored);
    expect(replayed.nextActions).toEqual(stored.next_actions);
    expect(replayed.workspaceFeedback.tasks.map(task => ({ kind: task.kind, status: task.status, target: task.target_node_id }))).toEqual(
      stored.workspace_feedback.tasks.map(task => ({ kind: task.kind, status: task.status, target: task.target_node_id })),
    );
    expect(replayed.workspaceFeedback.handoffs.map(handoff => ({ kind: handoff.handoff_kind, target: handoff.target_node_id, payload: handoff.payload }))).toEqual(
      stored.workspace_feedback.handoffs.map(handoff => ({ kind: handoff.handoff_kind, target: handoff.target_node_id, payload: handoff.payload })),
    );
  });

  it('derives delegated literature follow-up authority when feedback lowering explicitly backtracks to literature', () => {
    const runId = 'run-loop-literature-followup';
    const literatureNodeId = `evidence:${runId}`;
    const base = assertComputationResultValid({
      schema_version: 1,
      run_id: runId,
      objective_title: 'Backtrack literature after failed execution',
      manifest_ref: {
        uri: `rep://runs/${encodeURIComponent(runId)}/artifact/${encodeURIComponent('computation/manifest.json')}`,
        sha256: 'a'.repeat(64),
        size_bytes: 1,
      },
      execution_status: 'failed',
      produced_artifact_refs: [],
      started_at: '2026-04-14T00:00:00.000Z',
      finished_at: '2026-04-14T00:01:00.000Z',
      summary: 'Execution failed and should trigger a literature backtrack.',
      failure_reason: 'step failed',
      feedback_lowering: {
        signal: 'failure',
        decision_kind: 'literature_followup',
        priority_change: 'lower',
        prune_candidate: true,
        target_task_kind: 'literature',
        target_node_id: literatureNodeId,
        backtrack_to_task_kind: 'literature',
        backtrack_to_node_id: literatureNodeId,
      },
      next_actions: [{
        action_kind: 'literature_followup',
        task_kind: 'literature',
        title: 'Backtrack literature after failed execution',
        target_node_id: literatureNodeId,
        reason: 'Execution failed and should trigger a literature backtrack.',
        handoff_kind: 'feedback',
      }],
      followup_bridge_refs: [],
      executor_provenance: {
        orchestrator_component: '@autoresearch/orchestrator',
        execution_surface: 'orch_run_execute_manifest',
        approval_gate: 'A3',
        step_tools: ['python'],
        step_ids: ['task_001'],
      },
      workspace_feedback: {
        policy_mode: 'interactive',
        workspace: {
          schema_version: 1,
          workspace_id: `workspace:${runId}`,
          primary_question_id: `question:${runId}`,
          nodes: [
            { node_id: `question:${runId}`, kind: 'question', title: 'Backtrack literature after failed execution' },
            { node_id: `idea:${runId}`, kind: 'idea', title: 'Staged idea for Backtrack literature after failed execution' },
            { node_id: literatureNodeId, kind: 'evidence_set', title: 'Evidence follow-up for Backtrack literature after failed execution' },
            { node_id: `compute:${runId}`, kind: 'compute_attempt', title: 'Approved computation for Backtrack literature after failed execution' },
            { node_id: `finding:${runId}`, kind: 'finding', title: 'Finding from Backtrack literature after failed execution' },
            { node_id: `decision:${runId}`, kind: 'decision', title: 'Feedback decision for Backtrack literature after failed execution' },
          ],
          edges: [],
          created_at: '2026-04-14T00:00:00.000Z',
          updated_at: '2026-04-14T00:00:00.000Z',
        },
        tasks: [],
        events: [],
        handoffs: [],
        active_task_ids: [],
      },
    });

    const derived = deriveNextIdeaLoopState(base);
    expect(derived.nextActions).toEqual([{
      action_kind: 'literature_followup',
      task_kind: 'literature',
      title: 'Backtrack literature after Backtrack literature after failed execution',
      target_node_id: literatureNodeId,
      reason: 'step failed',
      handoff_kind: 'feedback',
    }]);
    const literatureTask = derived.workspaceFeedback.tasks.find(task => task.kind === 'literature')!;
    expect(literatureTask.status).toBe('pending');
    expect(literatureTask.metadata?.team_execution).toMatchObject({
      handoff_kind: 'feedback',
      workspace_id: derived.workspaceFeedback.workspace.workspace_id,
      research_task_ref: {
        task_id: literatureTask.task_id,
        task_kind: 'literature',
      },
    });
    expect(derived.workspaceFeedback.handoffs).toHaveLength(1);
    expect(derived.workspaceFeedback.handoffs[0]?.handoff_kind).toBe('feedback');
    expect(derived.workspaceFeedback.handoffs[0]?.target_node_id).toBe(literatureNodeId);
    expect(derived.workspaceFeedback.handoffs[0]?.payload.disposition).toBe('literature_followup');
  });
});
