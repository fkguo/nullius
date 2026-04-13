import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  buildTeamConfigForDelegatedFollowupTask,
  primeDelegatedFollowupTeamState,
} from '../src/computation/feedback-followups.js';
import { executeComputationManifest, progressDelegatedComputationFollowups } from '../src/computation/index.js';
import { assertComputationResultValid } from '../src/computation/result-schema.js';
import { handleOrchRunExecuteAgent } from '../src/orch-tools/agent-runtime.js';
import { TeamExecutionStateManager } from '../src/team-execution-storage.js';
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

  it('prefers the latest staged draft and review artifacts when seeding follow-up bridges', async () => {
    const projectRoot = makeTmpDir();
    const runId = 'run-writing-review-latest';
    registerCleanup(projectRoot);

    const { runDir, manifestPath } = createBridgeRun(runId, projectRoot);
    stageContextArtifact(runDir, 'section_output', 'aaa-old', {
      stagedAt: '2026-03-13T00:00:00Z',
      taskRef: { taskId: 'draft-old', taskKind: 'draft_update' },
    });
    stageContextArtifact(runDir, 'section_output', 'zzz-new', {
      stagedAt: '2026-03-13T00:00:10Z',
      taskRef: { taskId: 'draft-new', taskKind: 'draft_update' },
    });
    stageContextArtifact(runDir, 'reviewer_report', 'aaa-old', { stagedAt: '2026-03-13T00:00:01Z' });
    stageContextArtifact(runDir, 'reviewer_report', 'zzz-new', { stagedAt: '2026-03-13T00:00:11Z' });
    const manager = initRunState(projectRoot, runId);
    markA3Satisfied(manager, 'A3-0001');

    const result = await executeComputationManifest({ manifestPath, projectRoot, runDir, runId });
    expect(result.status).toBe('completed');

    const writingBridge = JSON.parse(
      fs.readFileSync(path.join(runDir, 'artifacts', 'writing_followup_bridge_v1.json'), 'utf-8'),
    ) as {
      context: { draft_source_artifact_name?: string };
    };
    const reviewBridge = JSON.parse(
      fs.readFileSync(path.join(runDir, 'artifacts', 'review_followup_bridge_v1.json'), 'utf-8'),
    ) as {
      context: {
        draft_source_artifact_name?: string;
        review_source_artifact_name?: string;
      };
    };

    expect(writingBridge.context.draft_source_artifact_name).toBe('staged_section_output_zzz-new.json');
    expect(reviewBridge.context.draft_source_artifact_name).toBe('staged_section_output_zzz-new.json');
    expect(reviewBridge.context.review_source_artifact_name).toBe('staged_reviewer_report_zzz-new.json');
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
    expect(writingTeam.research_task_ref).toMatchObject({
      task_id: draftTask.task_id,
      task_kind: 'draft_update',
      target_node_id: draftTask.target_node_id,
      workspace_id: writingTeam.workspace_id,
      handoff_id: writingHandoff.handoff_id,
      handoff_kind: 'writing',
      source_task_id: writingHandoff.source_task_id,
    });
    primeDelegatedFollowupTeamState({ projectRoot, runId, team: writingTeam });
    const primedRegistry = new TeamExecutionStateManager(projectRoot).loadTaskRefRegistry(runId);
    expect(primedRegistry?.refs_by_task_id[draftTask.task_id]).toMatchObject({
      task_id: draftTask.task_id,
      source_task_id: writingHandoff.source_task_id,
    });
    const { research_task_ref: _researchTaskRef, ...writingLaunchTeam } = writingTeam;

    const runtimeArgs = {
      _confirm: true as const,
      project_root: projectRoot,
      run_id: runId,
      model: 'claude-test',
      messages: [{
        role: 'assistant' as const,
        content: [{
          type: 'tool_use' as const,
          id: 'tu_bridge',
          name: 'orch_run_stage_content',
          input: {
            run_id: runId,
            run_dir: runDir,
            content_type: 'section_output',
            content: '{"section_number":"1","title":"Draft","content":"Updated draft"}',
            task_id: draftTask.task_id,
            task_kind: 'draft_update',
          },
        }],
      }],
      tools: [{ name: 'orch_run_stage_content', input_schema: { type: 'object', properties: {} } }],
      team: writingLaunchTeam,
    };

    const first = await handleOrchRunExecuteAgent(runtimeArgs, {
      callTool: vi.fn(async () => ({
        content: [{
          type: 'text',
          text: JSON.stringify({
            run_id: runId,
            artifact_name: `staged_section_output_${draftTask.task_id}.json`,
            staging_uri: `rep://runs/${runId}/artifact/${encodeURIComponent(`artifacts/staged_section_output_${draftTask.task_id}.json`)}`,
            content_bytes: 64,
          }),
        }],
        isError: false,
      })),
      createMessage: async () => { throw new Error('interrupt after checkpoint'); },
    }) as {
      last_completed_step: string;
      team_state_path: string;
      team_state: {
        workspace_id: string;
        delegate_assignments: Array<{
          assignment_id: string;
          task_id: string;
          task_kind: string;
          handoff_id: string | null;
          handoff_kind: string | null;
          checkpoint_id: string | null;
        }>;
        checkpoints: Array<{
          checkpoint_id: string;
          task_id: string;
          handoff_id: string | null;
        }>;
        sessions: Array<{ session_id: string }>;
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
    expect(first.team_state.delegate_assignments[0]).not.toHaveProperty('research_task_ref');
    expect(first.team_state.checkpoints[0]).toMatchObject({
      task_id: draftTask.task_id,
      handoff_id: writingHandoff.handoff_id,
    });
    expect(first.team_state.checkpoints[0]).not.toHaveProperty('research_task_ref');
    expect(first.team_state.sessions[0]).not.toHaveProperty('research_task_ref');
    const runtimeRegistry = new TeamExecutionStateManager(projectRoot).loadTaskRefRegistry(runId);
    expect(runtimeRegistry?.refs_by_task_id[draftTask.task_id]).toMatchObject({
      task_id: draftTask.task_id,
      source_task_id: writingHandoff.source_task_id,
    });
    expect(runtimeRegistry?.refs_by_assignment_id[first.team_state.delegate_assignments[0]!.assignment_id]).toMatchObject({
      task_id: draftTask.task_id,
      source_task_id: writingHandoff.source_task_id,
    });
    expect(runtimeRegistry?.refs_by_checkpoint_id[first.team_state.checkpoints[0]!.checkpoint_id]).toMatchObject({
      task_id: draftTask.task_id,
      source_task_id: writingHandoff.source_task_id,
    });
    expect(runtimeRegistry?.refs_by_session_id[first.team_state.sessions[0]!.session_id]).toMatchObject({
      task_id: draftTask.task_id,
      source_task_id: writingHandoff.source_task_id,
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

  it('refreshes the pending review bridge to the latest staged draft after draft completion without changing persisted node linkage', async () => {
    const projectRoot = makeTmpDir();
    const runId = 'run-review-refresh';
    registerCleanup(projectRoot);

    const { runDir, manifestPath } = createBridgeRun(runId, projectRoot);
    stageContextArtifact(runDir, 'section_output', 'zzz-old', {
      stagedAt: '2026-03-13T00:00:00Z',
      taskRef: { taskId: 'placeholder', taskKind: 'draft_update' },
    });
    stageContextArtifact(runDir, 'reviewer_report', 'mid-old', { stagedAt: '2026-03-13T00:00:01Z' });
    const manager = initRunState(projectRoot, runId);
    markA3Satisfied(manager, 'A3-0001');

    const result = await executeComputationManifest({ manifestPath, projectRoot, runDir, runId });
    expect(result.status).toBe('completed');

    const computationResult = assertComputationResultValid(
      JSON.parse(fs.readFileSync(path.join(runDir, 'artifacts', 'computation_result_v1.json'), 'utf-8')) as unknown,
    );
    const draftTask = computationResult.workspace_feedback.tasks.find(task => task.kind === 'draft_update')!;
    const reviewTask = computationResult.workspace_feedback.tasks.find(task => task.kind === 'review')!;

    let callCount = 0;
    const launchTask = vi.fn(async ({ task }) => {
      callCount += 1;
      if (callCount === 1) {
        expect(task.kind).toBe('draft_update');
        stageContextArtifact(runDir, 'section_output', 'aaa-new', {
          stagedAt: '2026-03-13T00:00:10Z',
          taskRef: { taskId: draftTask.task_id, taskKind: 'draft_update' },
        });
        stageContextArtifact(runDir, 'section_output', 'zzz-other', {
          stagedAt: '2026-03-13T00:00:20Z',
          taskRef: { taskId: 'other-draft-task', taskKind: 'draft_update' },
        });
        return {
          launchResult: {
            status: 'launched' as const,
            task_id: draftTask.task_id,
            task_kind: 'draft_update' as const,
            assignment_id: 'assign-draft-1',
          },
          teamState: {
            delegate_assignments: [
              { assignment_id: 'assign-draft-1', task_id: draftTask.task_id, task_kind: 'draft_update', status: 'completed' },
            ],
          },
        };
      }
      expect(task.kind).toBe('review');
      return {
        launchResult: {
          status: 'launched' as const,
          task_id: reviewTask.task_id,
          task_kind: 'review' as const,
          assignment_id: 'assign-review-1',
        },
        teamState: {
          delegate_assignments: [
            { assignment_id: 'assign-draft-1', task_id: draftTask.task_id, task_kind: 'draft_update', status: 'completed' },
            { assignment_id: 'assign-review-1', task_id: reviewTask.task_id, task_kind: 'review', status: 'running' },
          ],
        },
      };
    });

    const launchResult = await progressDelegatedComputationFollowups({
      computationResult,
      projectRoot,
      runId,
      runDir,
      launchTask,
    });

    expect(launchResult).toMatchObject({
      status: 'launched',
      task_id: reviewTask.task_id,
      task_kind: 'review',
    });

    const reviewBridge = JSON.parse(
      fs.readFileSync(path.join(runDir, 'artifacts', 'review_followup_bridge_v1.json'), 'utf-8'),
    ) as {
      target: { target_node_id: string; seed_payload: { source_artifact_name?: string; target_draft_node_id?: string } };
      handoff: { target_node_id: string; payload: { issue_node_id?: string; target_draft_node_id?: string } };
      context: { draft_source_artifact_name?: string };
    };

    expect(reviewBridge.context.draft_source_artifact_name).toContain('staged_section_output_aaa-new');
    expect(reviewBridge.context.draft_source_artifact_name).not.toContain('zzz-other');
    expect(reviewBridge.target.seed_payload.source_artifact_name).toContain('staged_section_output_aaa-new');
    expect(reviewBridge.target.target_node_id).toBe(reviewTask.target_node_id);
    expect(reviewBridge.handoff.target_node_id).toBe(reviewTask.target_node_id);
    expect(reviewBridge.handoff.payload.issue_node_id).toBe(reviewTask.target_node_id ?? undefined);
    expect(reviewBridge.handoff.payload.target_draft_node_id).toBe(draftTask.target_node_id ?? undefined);
  });
});
