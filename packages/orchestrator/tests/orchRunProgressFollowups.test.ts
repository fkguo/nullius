import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { handleToolCall } from '../src/tooling.js';
import { executeComputationManifest, stageContentInRunDir } from '../src/computation/index.js';
import { assertComputationResultValid } from '../src/computation/result-schema.js';
import { compileExecutionPlan } from '../src/computation/execution-plan.js';
import { executionPlanArtifactPath, materializeExecutionPlan } from '../src/computation/materialize-execution-plan.js';
import { deriveNextIdeaLoopState } from '../src/computation/loop-feedback.js';
import {
  cleanupRegisteredDirs,
  initRunState,
  makeTmpDir,
  markA3Satisfied,
  registerCleanup,
  writeJson,
} from './executeManifestTestUtils.js';
import {
  createBridgeRun as createWritingBridgeRun,
  stageContextArtifact,
} from './computeLoopWritingReviewBridgeTestSupport.js';

afterEach(() => {
  cleanupRegisteredDirs();
});

function textResponse(text: string) {
  return { model: 'claude-test', content: { type: 'text' as const, text }, stopReason: 'endTurn' };
}

function toolUseResponse(id: string, name: string, input: Record<string, unknown>) {
  return {
    model: 'claude-test',
    content: [{ type: 'tool_use' as const, id, name, input }],
    stopReason: 'tool_use',
  };
}

function extractPayload(res: unknown): Record<string, unknown> {
  const result = res as { content: Array<{ text: string }> };
  return JSON.parse(result.content[0]!.text) as Record<string, unknown>;
}

function createFeedbackBridgeRun(runId: string, projectRoot: string) {
  const runDir = path.join(projectRoot, runId);
  fs.mkdirSync(runDir, { recursive: true });
  const executionPlan = compileExecutionPlan(runId, {
    outline_seed_path: 'artifacts/outline_seed_v1.json',
    outline: {
      thesis: 'Progress follow-ups should continue delegated idea tasks through the generic orchestrator surface.',
      claims: [{ claim_text: 'Claim A' }],
      hypotheses: ['Hypothesis A'],
      source_handoff_uri: '/tmp/idea-handoff.json',
    },
    hints: {
      minimal_compute_plan: [{ step: 'Evaluate the bridge task', method: 'generic execution', estimated_difficulty: 'low' }],
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
      `payload = {'feedback_signal': '${feedbackSignal}', 'task_id': args.task_id}`,
      "output_path = Path('outputs') / f\"{args.task_id}.json\"",
      'output_path.parent.mkdir(parents=True, exist_ok=True)',
      "output_path.write_text(json.dumps(payload) + '\\n', encoding='utf-8')",
    ].join('\n'),
    'utf-8',
  );
}

describe('orch_run_progress_followups', () => {
  it('launches a delegated idea feedback follow-up for a failed computation result and does not relaunch it on the next tick', async () => {
    const projectRoot = makeTmpDir();
    const runId = 'run-progress-feedback-failure';
    registerCleanup(projectRoot);

    const { runDir, manifestPath } = createFeedbackBridgeRun(runId, projectRoot);
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

    const ctx = {
      createMessage: async () => textResponse('feedback acknowledged'),
      callTool: async () => ({ content: [{ type: 'text', text: '{}' }], isError: false }),
    };

    const first = extractPayload(await handleToolCall(
      'orch_run_progress_followups',
      {
        _confirm: true,
        project_root: projectRoot,
        run_id: runId,
        run_dir: runDir,
      },
      'full',
      ctx,
    ));

    expect(first).toMatchObject({
      status: 'launched',
      branch: 'feedback',
      task_kind: 'idea',
    });
    const second = extractPayload(await handleToolCall(
      'orch_run_progress_followups',
      {
        _confirm: true,
        project_root: projectRoot,
        run_id: runId,
        run_dir: runDir,
      },
      'full',
      ctx,
    ));
    expect(second).toEqual({
      status: 'skipped_no_pending_task',
      branch: 'none',
    });
  });

  it('launches a delegated branched-idea feedback follow-up for a weak-signal computation result', async () => {
    const projectRoot = makeTmpDir();
    const runId = 'run-progress-feedback-weak-signal';
    registerCleanup(projectRoot);

    const { runDir, manifestPath } = createFeedbackBridgeRun(runId, projectRoot);
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

    const launched = extractPayload(await handleToolCall(
      'orch_run_progress_followups',
      {
        _confirm: true,
        project_root: projectRoot,
        run_id: runId,
        run_dir: runDir,
      },
      'full',
      {
        createMessage: async () => textResponse('branch idea acknowledged'),
        callTool: async () => ({ content: [{ type: 'text', text: '{}' }], isError: false }),
      },
    ));

    expect(launched).toMatchObject({
      status: 'launched',
      branch: 'feedback',
      task_kind: 'idea',
    });
  });

  it('routes pending draft_update then review follow-ups through the same generic front door on successive calls', async () => {
    const projectRoot = makeTmpDir();
    const runId = 'run-progress-writing-review';
    registerCleanup(projectRoot);

    const { runDir, manifestPath } = createWritingBridgeRun(runId, projectRoot);
    stageContextArtifact(runDir, 'section_output', 'draft-seed');
    stageContextArtifact(runDir, 'reviewer_report', 'review-seed');
    const manager = initRunState(projectRoot, runId);
    markA3Satisfied(manager, 'A3-0001');

    const executed = await executeComputationManifest({
      manifestPath,
      projectRoot,
      runDir,
      runId,
    });
    expect(executed.status).toBe('completed');

    const computationResult = assertComputationResultValid(
      JSON.parse(fs.readFileSync(path.join(runDir, 'artifacts', 'computation_result_v1.json'), 'utf-8')) as unknown,
    );
    expect(computationResult.verification_refs?.subject_refs).toHaveLength(1);
    expect(computationResult.verification_refs?.subject_verdict_refs).toHaveLength(1);
    expect(computationResult.verification_refs?.coverage_refs).toHaveLength(1);
    const draftTask = computationResult.workspace_feedback.tasks.find(task => task.kind === 'draft_update')!;
    const reviewTask = computationResult.workspace_feedback.tasks.find(task => task.kind === 'review')!;
    const responseQueue = [
      toolUseResponse('tu_stage_draft', 'orch_run_stage_content', {
        run_id: runId,
        run_dir: runDir,
        content_type: 'section_output',
        content: '{"section_number":"1","title":"Draft","content":"Updated draft"}',
        task_id: draftTask.task_id,
        task_kind: 'draft_update',
      }),
      textResponse('draft follow-up complete'),
      toolUseResponse('tu_stage_review_report', 'orch_run_stage_content', {
        run_id: runId,
        run_dir: runDir,
        content_type: 'reviewer_report',
        content: '{"summary":"review"}',
        task_id: reviewTask.task_id,
        task_kind: 'review',
      }),
      toolUseResponse('tu_stage_review_decision', 'orch_run_stage_content', {
        run_id: runId,
        run_dir: runDir,
        content_type: 'judge_decision',
        content: '{"schema_version":1,"disposition":"accept","reason":"Looks good."}',
        task_id: reviewTask.task_id,
        task_kind: 'review',
      }),
      textResponse('review follow-up complete'),
    ];

    const ctx = {
      createMessage: async () => {
        const next = responseQueue.shift();
        if (!next) {
          throw new Error('unexpected extra createMessage call');
        }
        return next;
      },
      callTool: async (name: string, args: Record<string, unknown>) => {
        if (name !== 'orch_run_stage_content') {
          return { content: [{ type: 'text', text: JSON.stringify({ error: 'unexpected tool' }) }], isError: true };
        }
        const payload = stageContentInRunDir({
          runId,
          runDir,
          contentType: args.content_type as 'section_output' | 'reviewer_report' | 'judge_decision',
          content: String(args.content),
          taskId: args.task_id as string,
          taskKind: args.task_kind as 'draft_update' | 'review',
        });
        return {
          content: [{ type: 'text', text: JSON.stringify(payload) }],
          isError: false,
        };
      },
    };

    const first = extractPayload(await handleToolCall(
      'orch_run_progress_followups',
      {
        _confirm: true,
        project_root: projectRoot,
        run_id: runId,
        run_dir: runDir,
      },
      'full',
      ctx,
    ));
    expect(first).toMatchObject({
      status: 'launched',
      branch: 'writing_review',
      task_id: draftTask.task_id,
      task_kind: 'draft_update',
    });

    const second = extractPayload(await handleToolCall(
      'orch_run_progress_followups',
      {
        _confirm: true,
        project_root: projectRoot,
        run_id: runId,
        run_dir: runDir,
      },
      'full',
      ctx,
    ));
    expect(second).toMatchObject({
      status: 'launched',
      branch: 'writing_review',
      task_id: reviewTask.task_id,
      task_kind: 'review',
    });
  });

  it('launches a delegated literature follow-up when the computation result carries explicit delegated feedback authority', async () => {
    const projectRoot = makeTmpDir();
    const runId = 'run-progress-literature-followup';
    registerCleanup(projectRoot);

    const { runDir, manifestPath } = createFeedbackBridgeRun(runId, projectRoot);
    fs.writeFileSync(
      path.join(runDir, 'computation', 'scripts', 'execution_plan_runner.py'),
      "raise SystemExit(1)\n",
      'utf-8',
    );
    const manager = initRunState(projectRoot, runId);
    markA3Satisfied(manager, 'A3-0001');

    const executed = await executeComputationManifest({
      manifestPath,
      projectRoot,
      runDir,
      runId,
    });
    expect(executed.status).toBe('failed');

    const outcomePath = path.join(runDir, 'artifacts', 'computation_result_v1.json');
    const outcome = assertComputationResultValid(
      JSON.parse(fs.readFileSync(outcomePath, 'utf-8')) as unknown,
    );
    const literatureNode = outcome.workspace_feedback.workspace.nodes.find(node => node.kind === 'evidence_set')!;
    const rewrittenSeed = deriveNextIdeaLoopState({
      ...outcome,
      feedback_lowering: {
        ...outcome.feedback_lowering,
        decision_kind: 'literature_followup',
        target_task_kind: 'literature',
        target_node_id: literatureNode.node_id,
        backtrack_to_task_kind: 'literature',
        backtrack_to_node_id: literatureNode.node_id,
      },
    });
    const rewritten = assertComputationResultValid({
      ...outcome,
      feedback_lowering: {
        ...outcome.feedback_lowering,
        decision_kind: 'literature_followup',
        target_task_kind: 'literature',
        target_node_id: literatureNode.node_id,
        backtrack_to_task_kind: 'literature',
        backtrack_to_node_id: literatureNode.node_id,
      },
      next_actions: rewrittenSeed.nextActions,
      workspace_feedback: rewrittenSeed.workspaceFeedback,
    });
    fs.writeFileSync(outcomePath, JSON.stringify(rewritten, null, 2) + '\n', 'utf-8');

    const launched = extractPayload(await handleToolCall(
      'orch_run_progress_followups',
      {
        _confirm: true,
        project_root: projectRoot,
        run_id: runId,
        run_dir: runDir,
      },
      'full',
      {
        createMessage: async () => textResponse('literature follow-up complete'),
        callTool: async () => ({ content: [{ type: 'text', text: '{}' }], isError: false }),
      },
    ));

    expect(launched).toMatchObject({
      status: 'launched',
      branch: 'feedback',
      task_kind: 'literature',
    });

    const second = extractPayload(await handleToolCall(
      'orch_run_progress_followups',
      {
        _confirm: true,
        project_root: projectRoot,
        run_id: runId,
        run_dir: runDir,
      },
      'full',
      {
        createMessage: async () => textResponse('unused'),
        callTool: async () => ({ content: [{ type: 'text', text: '{}' }], isError: false }),
      },
    ));
    expect(second).toEqual({
      status: 'skipped_no_pending_task',
      branch: 'none',
    });
  });

  it('fails closed when a literature follow-up is pending without delegated feedback authority', async () => {
    const projectRoot = makeTmpDir();
    const runId = 'run-progress-literature-invalid-authority';
    registerCleanup(projectRoot);

    const { runDir, manifestPath } = createFeedbackBridgeRun(runId, projectRoot);
    fs.writeFileSync(
      path.join(runDir, 'computation', 'scripts', 'execution_plan_runner.py'),
      "raise SystemExit(1)\n",
      'utf-8',
    );
    const manager = initRunState(projectRoot, runId);
    markA3Satisfied(manager, 'A3-0001');

    const executed = await executeComputationManifest({
      manifestPath,
      projectRoot,
      runDir,
      runId,
    });
    expect(executed.status).toBe('failed');

    const outcomePath = path.join(runDir, 'artifacts', 'computation_result_v1.json');
    const outcome = assertComputationResultValid(
      JSON.parse(fs.readFileSync(outcomePath, 'utf-8')) as unknown,
    );
    const literatureNode = outcome.workspace_feedback.workspace.nodes.find(node => node.kind === 'evidence_set')!;
    const baseTask = outcome.workspace_feedback.tasks.find(task => task.kind === 'idea')!;
    const rewritten = assertComputationResultValid({
      ...outcome,
      feedback_lowering: {
        ...outcome.feedback_lowering,
        decision_kind: 'literature_followup',
        target_task_kind: 'literature',
        target_node_id: literatureNode.node_id,
        backtrack_to_task_kind: 'literature',
        backtrack_to_node_id: literatureNode.node_id,
      },
      next_actions: [{
        ...outcome.next_actions[0]!,
        action_kind: 'literature_followup',
        task_kind: 'literature',
        target_node_id: literatureNode.node_id,
        title: 'Backtrack literature after failure',
      }],
      workspace_feedback: {
        ...outcome.workspace_feedback,
        tasks: [{
          ...baseTask,
          kind: 'literature',
          title: 'Backtrack literature after failure',
          target_node_id: literatureNode.node_id,
          metadata: undefined,
        }],
        handoffs: [],
      },
    });
    fs.writeFileSync(outcomePath, JSON.stringify(rewritten, null, 2) + '\n', 'utf-8');

    const invalid = extractPayload(await handleToolCall(
      'orch_run_progress_followups',
      {
        _confirm: true,
        project_root: projectRoot,
        run_id: runId,
        run_dir: runDir,
      },
      'full',
      {
        createMessage: async () => textResponse('unused'),
        callTool: async () => ({ content: [{ type: 'text', text: '{}' }], isError: false }),
      },
    ));
    expect(invalid).toEqual({
      status: 'skipped_invalid_team_execution',
      branch: 'feedback',
      task_kind: 'literature',
      error: 'literature follow-up is pending but missing delegated feedback authority',
    });
  });
});
