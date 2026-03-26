import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildTeamConfigForDelegatedFollowupTask } from '../src/computation/feedback-followups.js';
import { executeComputationManifest } from '../src/computation/index.js';
import { assertComputationResultValid } from '../src/computation/result-schema.js';
import { handleOrchRunExecuteAgent } from '../src/orch-tools/agent-runtime.js';
import {
  cleanupRegisteredDirs,
  initRunState,
  makeTmpDir,
  markA3Satisfied,
  registerCleanup,
} from './executeManifestTestUtils.js';
import {
  createBridgeRun,
  readOutcome,
  stageContextArtifact,
  textResponse,
} from './computeLoopWritingReviewBridgeTestSupport.js';

afterEach(() => {
  cleanupRegisteredDirs();
});

function verificationUriBuckets(verificationRefs: {
  subject_refs?: Array<{ uri: string }>;
  check_run_refs?: Array<{ uri: string }>;
  subject_verdict_refs?: Array<{ uri: string }>;
  coverage_refs?: Array<{ uri: string }>;
} | undefined) {
  return {
    subject_refs: (verificationRefs?.subject_refs ?? []).map(ref => ref.uri),
    check_run_refs: (verificationRefs?.check_run_refs ?? []).map(ref => ref.uri),
    subject_verdict_refs: (verificationRefs?.subject_verdict_refs ?? []).map(ref => ref.uri),
    coverage_refs: (verificationRefs?.coverage_refs ?? []).map(ref => ref.uri),
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
    const computationResult = assertComputationResultValid(
      JSON.parse(fs.readFileSync(path.join(runDir, 'artifacts', 'computation_result_v1.json'), 'utf-8')) as unknown,
    );
    const resultVerificationUris = verificationUriBuckets(computationResult.verification_refs);

    const writingBridge = JSON.parse(
      fs.readFileSync(path.join(runDir, 'artifacts', 'writing_followup_bridge_v1.json'), 'utf-8'),
    ) as {
      bridge_kind: string;
      context: { draft_context_mode: string };
      target: { task_kind: string; suggested_content_type: string; seed_payload: { finding_node_ids: string[] } };
      verification_refs?: {
        subject_refs?: Array<{ uri: string }>;
        check_run_refs?: Array<{ uri: string }>;
        subject_verdict_refs?: Array<{ uri: string }>;
        coverage_refs?: Array<{ uri: string }>;
      };
      handoff?: unknown;
    };
    expect(writingBridge.bridge_kind).toBe('writing');
    expect(writingBridge.context.draft_context_mode).toBe('seeded_draft');
    expect(writingBridge.target.task_kind).toBe('draft_update');
    expect(writingBridge.target.suggested_content_type).toBe('section_output');
    expect(writingBridge.target.seed_payload.finding_node_ids).toEqual([`finding:${runId}`]);
    expect(verificationUriBuckets(writingBridge.verification_refs)).toEqual(resultVerificationUris);
    expect(writingBridge.verification_refs).not.toHaveProperty('check_run_refs');
    expect(writingBridge.handoff).toBeUndefined();
  });

  it('launches the real computation writing follow-up through orch_run_execute_agent.team and resumes from persisted team state', async () => {
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
    const draftTask = outcome.workspace_feedback.tasks.find(task => task.kind === 'draft_update')!;
    const reviewTask = outcome.workspace_feedback.tasks.find(task => task.kind === 'review')!;
    const computationResult = assertComputationResultValid(
      JSON.parse(fs.readFileSync(path.join(runDir, 'artifacts', 'computation_result_v1.json'), 'utf-8')) as unknown,
    );
    const resultVerificationUris = verificationUriBuckets(computationResult.verification_refs);
    const writingTeam = buildTeamConfigForDelegatedFollowupTask(draftTask);
    const reviewTeam = buildTeamConfigForDelegatedFollowupTask(reviewTask);
    const writingHandoff = outcome.workspace_feedback.handoffs.find(handoff => handoff.handoff_id === writingTeam.handoff_id)!;
    expect(reviewTeam.handoff_kind).toBe('review');
    expect(writingHandoff.workspace_id).toBe(writingTeam.workspace_id);

    const runtimeArgs = {
      _confirm: true as const,
      project_root: projectRoot,
      run_id: runId,
      model: 'claude-test',
      messages: [{
        role: 'assistant' as const,
        content: [{ type: 'tool_use' as const, id: 'tu_bridge', name: 'do_thing', input: {} }],
      }],
      tools: [{ name: 'do_thing', input_schema: { type: 'object', properties: {} } }],
      team: writingTeam,
    };

    const first = await handleOrchRunExecuteAgent(runtimeArgs, {
      callTool: vi.fn(async () => ({ content: [{ type: 'text', text: 'tool-result' }], isError: false })),
      createMessage: async () => { throw new Error('interrupt after checkpoint'); },
    }) as {
      last_completed_step: string;
      team_state_path: string;
      team_state: {
        workspace_id: string;
        delegate_assignments: Array<{
          task_id: string;
          task_kind: string;
          handoff_id: string | null;
          handoff_kind: string | null;
          checkpoint_id: string | null;
        }>;
        checkpoints: Array<{ checkpoint_id: string; task_id: string; handoff_id: string | null }>;
      };
    };
    expect(first.last_completed_step).toBe('tu_bridge');
    expect(fs.existsSync(first.team_state_path)).toBe(true);
    expect(first.team_state.workspace_id).toBe(writingTeam.workspace_id);
    expect(first.team_state.delegate_assignments[0]).toMatchObject({
      task_id: draftTask.task_id,
      task_kind: 'draft_update',
      handoff_id: writingHandoff.handoff_id,
      handoff_kind: 'writing',
    });
    expect(first.team_state.checkpoints[0]).toMatchObject({
      task_id: draftTask.task_id,
      handoff_id: writingHandoff.handoff_id,
    });

    const resumedCall = vi.fn(async () => ({ content: [{ type: 'text', text: 'should-not-run' }], isError: false }));
    const resumed = await handleOrchRunExecuteAgent(runtimeArgs, {
      callTool: resumedCall,
      createMessage: async () => textResponse('resumed'),
    }) as {
      resumed: boolean;
      skipped_step_ids: string[];
      team_state: {
        checkpoints: Array<{ checkpoint_id: string; resume_from: string | null }>;
        delegate_assignments: Array<{ resume_from: string | null }>;
      };
    };
    expect(resumed.resumed).toBe(true);
    expect(resumed.skipped_step_ids).toEqual(['tu_bridge']);
    expect(resumed.team_state.delegate_assignments[0]?.resume_from).toBe('tu_bridge');
    expect(resumed.team_state.checkpoints[0]?.checkpoint_id).toBe(first.team_state.checkpoints[0]?.checkpoint_id);
    expect(resumed.team_state.checkpoints[0]?.resume_from).toBe('tu_bridge');
    expect(resumedCall).not.toHaveBeenCalled();

    const writingBridge = JSON.parse(
      fs.readFileSync(path.join(runDir, 'artifacts', 'writing_followup_bridge_v1.json'), 'utf-8'),
    ) as {
      context: { draft_context_mode: string; draft_source_artifact_name: string };
      verification_refs?: {
        subject_refs?: Array<{ uri: string }>;
        check_run_refs?: Array<{ uri: string }>;
        subject_verdict_refs?: Array<{ uri: string }>;
        coverage_refs?: Array<{ uri: string }>;
      };
      handoff?: { handoff_kind: string };
    };
    const reviewBridge = JSON.parse(
      fs.readFileSync(path.join(runDir, 'artifacts', 'review_followup_bridge_v1.json'), 'utf-8'),
    ) as {
      bridge_kind: string;
      context: { review_source_artifact_name?: string };
      target: { suggested_content_type: string };
      verification_refs?: {
        subject_refs?: Array<{ uri: string }>;
        check_run_refs?: Array<{ uri: string }>;
        subject_verdict_refs?: Array<{ uri: string }>;
        coverage_refs?: Array<{ uri: string }>;
      };
      handoff: { handoff_kind: string };
    };
    expect(writingBridge.context.draft_context_mode).toBe('existing_draft');
    expect(writingBridge.context.draft_source_artifact_name).toContain('staged_section_output');
    expect(verificationUriBuckets(writingBridge.verification_refs)).toEqual(resultVerificationUris);
    expect(writingBridge.verification_refs).not.toHaveProperty('check_run_refs');
    expect(writingBridge.handoff?.handoff_kind).toBe('writing');
    expect(reviewBridge.bridge_kind).toBe('review');
    expect(reviewBridge.context.review_source_artifact_name).toContain('staged_reviewer_report');
    expect(reviewBridge.target.suggested_content_type).toBe('reviewer_report');
    expect(verificationUriBuckets(reviewBridge.verification_refs)).toEqual(resultVerificationUris);
    expect(reviewBridge.verification_refs).not.toHaveProperty('check_run_refs');
    expect(reviewBridge.handoff.handoff_kind).toBe('review');
  });
});
