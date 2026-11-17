import * as fs from 'node:fs';
import * as path from 'node:path';
import { explicitArtifactWriterMethod } from './explicitArtifactWriterMethod.js';
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
  const runDir = path.join(projectRoot, 'artifacts', 'runs', runId);
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
  const { manifestPath } = materializeExecutionPlan(runDir, executionPlan, { methodSpec: explicitArtifactWriterMethod(executionPlan) });
  return { runDir, manifestPath };
}

function writeFeedbackSignalRunner(runDir: string, feedbackSignal: 'success' | 'weak_signal' | 'failure'): void {
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
      "Path('outputs/research_feedback.json').write_text(json.dumps(payload) + '\\n', encoding='utf-8')",
    ].join('\n'),
    'utf-8',
  );
  const manifestPath = path.join(runDir, 'computation', 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
  manifest.steps.at(-1).expected_outputs = [...new Set([...manifest.steps.at(-1).expected_outputs, 'outputs/research_feedback.json'])];
  manifest.outputs = [...new Set([...manifest.outputs, 'outputs/research_feedback.json'])];
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
}

function withExplicitLiteratureFeedback(outcome: ReturnType<typeof assertComputationResultValid>) {
  expect(outcome.feedback_lowering?.signal).toBe('failure');
  const feedbackLowering = {
    ...outcome.feedback_lowering!,
    decision_kind: 'literature_followup' as const,
    target_task_kind: 'literature' as const,
    target_node_id: `evidence:${outcome.run_id}`,
    backtrack_to_task_kind: 'literature' as const,
    backtrack_to_node_id: `evidence:${outcome.run_id}`,
  };
  const derived = deriveNextIdeaLoopState({ ...outcome, feedback_lowering: feedbackLowering });
  return assertComputationResultValid({
    ...outcome,
    feedback_lowering: feedbackLowering,
    next_actions: derived.nextActions,
    workspace_feedback: derived.workspaceFeedback,
  });
}

describe('orch_run_progress_followups', () => {
  it.each(['execution_failed', 'declared_negative'] as const)('launches idea feedback only for a completed producer declaration and never relaunches: %s', async (mode) => {
    const projectRoot = makeTmpDir();
    const runId = `run-progress-feedback-${mode}`;
    registerCleanup(projectRoot);

    const { runDir, manifestPath } = createFeedbackBridgeRun(runId, projectRoot);
    if (mode === 'execution_failed') {
      fs.writeFileSync(path.join(runDir, 'computation', 'scripts', 'execution_plan_runner.py'), 'raise SystemExit(1)\n', 'utf-8');
    } else {
      writeFeedbackSignalRunner(runDir, 'failure');
    }
    const manager = initRunState(projectRoot, runId);
    markA3Satisfied(manager, 'A3-0001');

    const result = await executeComputationManifest({
      manifestPath,
      projectRoot,
      runDir,
      runId,
    });
    expect(result.status).toBe(mode === 'execution_failed' ? 'failed' : 'completed');

    let samplingCalls = 0;
    const ctx = {
      createMessage: async () => {
        samplingCalls += 1;
        return textResponse('feedback acknowledged');
      },
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

    expect(first).toMatchObject(mode === 'declared_negative'
      ? { status: 'launched', branch: 'feedback', task_kind: 'idea' }
      : { status: 'skipped_no_pending_task', branch: 'none' });
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
    expect(samplingCalls).toBe(mode === 'declared_negative' ? 1 : 0);
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

    // The progress tool works only in the run's own directory.
    const { runDir, manifestPath } = createWritingBridgeRun(runId, projectRoot, path.join(projectRoot, 'artifacts', 'runs', runId));
    writeFeedbackSignalRunner(runDir, 'success');
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
    expect(computationResult.workspace_feedback.workspace.nodes.find(node => node.kind === 'finding')?.metadata).toMatchObject({ basis: 'producer_declaration', independently_verified: false });
    const draftTask = computationResult.workspace_feedback.tasks.find(task => task.kind === 'draft_update')!;
    const reviewTask = computationResult.workspace_feedback.tasks.find(task => task.kind === 'review')!;
    const responseQueue = [
      toolUseResponse('tu_stage_draft', 'orch_run_stage_content', {
        project_root: projectRoot,
        run_id: runId,
        run_dir: runDir,
        content_type: 'section_output',
        content: '{"section_number":"1","title":"Draft","content":"Updated draft"}',
        task_id: draftTask.task_id,
        task_kind: 'draft_update',
      }),
      textResponse('draft follow-up complete'),
      toolUseResponse('tu_stage_review_report', 'orch_run_stage_content', {
        project_root: projectRoot,
        run_id: runId,
        run_dir: runDir,
        content_type: 'reviewer_report',
        content: '{"summary":"review"}',
        task_id: reviewTask.task_id,
        task_kind: 'review',
      }),
      toolUseResponse('tu_stage_review_decision', 'orch_run_stage_content', {
        project_root: projectRoot,
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
    writeFeedbackSignalRunner(runDir, 'failure');
    const manager = initRunState(projectRoot, runId);
    markA3Satisfied(manager, 'A3-0001');

    const executed = await executeComputationManifest({
      manifestPath,
      projectRoot,
      runDir,
      runId,
    });
    expect(executed.status).toBe('completed');

    const outcomePath = path.join(runDir, 'artifacts', 'computation_result_v1.json');
    const outcome = assertComputationResultValid(
      JSON.parse(fs.readFileSync(outcomePath, 'utf-8')) as unknown,
    );
    const rewritten = withExplicitLiteratureFeedback(outcome);
    expect(rewritten.workspace_feedback.workspace.nodes.find(node => node.node_id === `evidence:${runId}`)).toMatchObject({ metadata: { role: 'requested_work', accepted_evidence: false } });
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
    writeFeedbackSignalRunner(runDir, 'failure');
    const manager = initRunState(projectRoot, runId);
    markA3Satisfied(manager, 'A3-0001');

    const executed = await executeComputationManifest({
      manifestPath,
      projectRoot,
      runDir,
      runId,
    });
    expect(executed.status).toBe('completed');

    const outcomePath = path.join(runDir, 'artifacts', 'computation_result_v1.json');
    const outcome = assertComputationResultValid(
      JSON.parse(fs.readFileSync(outcomePath, 'utf-8')) as unknown,
    );
    const delegated = withExplicitLiteratureFeedback(outcome);
    const rewritten = assertComputationResultValid({
      ...delegated,
      workspace_feedback: {
        ...delegated.workspace_feedback,
        tasks: delegated.workspace_feedback.tasks.map(task => task.kind === 'literature' ? { ...task, metadata: undefined } : task),
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
