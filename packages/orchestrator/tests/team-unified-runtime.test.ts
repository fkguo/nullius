import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { ComputationResultV1 } from '@autoresearch/shared';

import {
  executeComputationManifest,
  executeTeamDelegatedRuntime,
  executeUnifiedTeamRuntime,
  primeDelegatedFollowupTeamState,
  stageContentInRunDir,
  type TeamPermissionMatrix,
} from '../src/index.js';
import { assertComputationResultValid } from '../src/computation/result-schema.js';
import {
  initRunState,
  markA3Satisfied,
} from './executeManifestTestUtils.js';
import { createBridgeRun } from './computeLoopWritingReviewBridgeTestSupport.js';
import {
  assignmentNeedsApprovalAttention,
  summarizeRuntimeProjectionForOperator,
  taskProjectionFromAssignmentStatus,
} from '../src/operator-read-model-summary.js';
import { TeamExecutionStateManager } from '../src/team-execution-storage.js';

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'team-unified-runtime-'));
}

function ensureRunDir(projectRoot: string, runId: string): string {
  const runDir = path.join(projectRoot, runId);
  fs.mkdirSync(path.join(runDir, 'artifacts'), { recursive: true });
  return runDir;
}

async function prepareReviewLoweringRun(projectRoot: string, runId: string): Promise<{
  runDir: string;
  reviewNodeId: string;
  evidenceNodeId: string;
  workspaceId: string;
}> {
  const { runDir, manifestPath } = createBridgeRun(runId, projectRoot);
  stageContentInRunDir({
    runId,
    runDir,
    contentType: 'section_output',
    artifactSuffix: 'draft-seed',
    content: '{"section_number":"1","title":"Draft seed","content":"Seed draft"}',
  });
  stageContentInRunDir({
    runId,
    runDir,
    contentType: 'reviewer_report',
    artifactSuffix: 'review-seed',
    content: '{"summary":"Seed review"}',
  });
  const manager = initRunState(projectRoot, runId);
  markA3Satisfied(manager, 'A3-0001');
  const result = await executeComputationManifest({ manifestPath, projectRoot, runDir, runId });
  if (result.status !== 'completed') {
    throw new Error(`expected completed computation result, received ${result.status}`);
  }
  const computationResult = assertComputationResultValid(
    JSON.parse(fs.readFileSync(path.join(runDir, 'artifacts', 'computation_result_v1.json'), 'utf-8')) as ComputationResultV1,
  );
  const reviewNodeId = computationResult.workspace_feedback.workspace.nodes.find(node => node.kind === 'review_issue')?.node_id;
  const evidenceNodeId = computationResult.workspace_feedback.workspace.nodes.find(node => node.kind === 'evidence_set')?.node_id;
  if (!reviewNodeId || !evidenceNodeId) {
    throw new Error('expected computation result workspace to include review_issue and evidence_set nodes');
  }
  return {
    runDir,
    reviewNodeId,
    evidenceNodeId,
    workspaceId: computationResult.workspace_feedback.workspace.workspace_id,
  };
}

function textResponse(text: string) {
  return {
    content: [{ type: 'text' as const, text }],
    stop_reason: 'end_turn',
  };
}

function toolUseResponse(id: string, name: string, input: Record<string, unknown> = {}) {
  return {
    content: [{ type: 'tool_use' as const, id, name, input }],
    stop_reason: 'tool_use',
  };
}

function extractTaskId(params: {
  messages: Array<{ role: string; content: unknown }>;
}): string {
  const protocol = params.messages
    .filter(message => message.role === 'user' && typeof message.content === 'string')
    .map(message => message.content)
    .find(content => content.includes('## TASK'));
  if (!protocol || typeof protocol !== 'string') {
    throw new Error('missing delegation protocol');
  }
  if (protocol.includes('task-mcp-parent')) return 'task-mcp-parent';
  if (protocol.includes('task-mcp-child')) return 'task-mcp-child';
  if (protocol.includes('task-parallel-1')) return 'task-parallel-1';
  if (protocol.includes('task-parallel-2')) return 'task-parallel-2';
  if (protocol.includes('task-recover-1')) return 'task-recover-1';
  if (protocol.includes('task-recover-2')) return 'task-recover-2';
  if (protocol.includes('task-recover-timeout-2')) return 'task-recover-timeout-2';
  if (protocol.includes('task-timeout-3')) return 'task-timeout-3';
  if (protocol.includes('task-complete-1')) return 'task-complete-1';
  if (protocol.includes('task-review-2')) return 'task-review-2';
  return 'task-compute-1';
}

function extractProtocolText(params: {
  messages: Array<{ role: string; content: unknown }>;
}): string {
  const protocol = params.messages
    .filter(message => message.role === 'user' && typeof message.content === 'string')
    .map(message => message.content)
    .find(content => content.includes('## TASK'));
  if (!protocol || typeof protocol !== 'string') {
    throw new Error('missing delegation protocol');
  }
  return protocol;
}

const PERMISSIONS: TeamPermissionMatrix = {
  delegation: [
    {
      from_role: 'lead',
      to_role: 'delegate',
      allowed_task_kinds: ['compute', 'review'],
      allowed_handoff_kinds: ['compute', 'review'],
    },
  ],
  interventions: [
    {
      actor_role: 'lead',
      allowed_scopes: ['task', 'team'],
      allowed_kinds: ['pause', 'resume', 'cancel', 'cascade_stop'],
    },
    {
      actor_role: 'lead',
      allowed_scopes: ['task'],
      allowed_kinds: ['approve', 'redirect', 'inject_task'],
    },
  ],
};

describe('operator read-model summary helper', () => {
  it('projects runtime diagnostics with one shared status/cause/action vocabulary', () => {
    expect(summarizeRuntimeProjectionForOperator({
      version: 1,
      turn_count: 1,
      recovery_turn_count: 0,
      dialogue_turn_count: 1,
      projected_turns: [],
      runtime_marker_kinds: [],
      approval_requested: true,
      terminal_outcome: {
        type: 'done',
        phase: 'dialogue',
        turn_count: 1,
        stop_reason: 'approval_required',
      },
    })).toEqual({
      status: 'awaiting_approval',
      primary_cause: 'approval_required',
      recommended_action: 'approve_or_reject_and_resume',
    });

    expect(summarizeRuntimeProjectionForOperator({
      version: 1,
      turn_count: 2,
      recovery_turn_count: 0,
      dialogue_turn_count: 2,
      projected_turns: [],
      runtime_marker_kinds: ['truncation_retry'],
      approval_requested: false,
      terminal_outcome: {
        type: 'done',
        phase: 'dialogue',
        turn_count: 2,
        stop_reason: 'end_turn',
      },
    })).toEqual({
      status: 'degraded',
      primary_cause: 'truncation',
      recommended_action: 'compact_or_reduce_context',
    });
  });

  it('projects assignment runtime status into task lifecycle/status and approval attention consistently', () => {
    expect(taskProjectionFromAssignmentStatus('awaiting_approval')).toEqual({
      task_lifecycle_status: 'running',
      task_status: 'active',
    });
    expect(taskProjectionFromAssignmentStatus('timed_out')).toEqual({
      task_lifecycle_status: 'failed',
      task_status: 'blocked',
    });
    expect(taskProjectionFromAssignmentStatus('cascade_stopped')).toEqual({
      task_lifecycle_status: 'killed',
      task_status: 'cancelled',
    });
    expect(assignmentNeedsApprovalAttention('paused', 'awaiting_approval')).toBe(true);
    expect(assignmentNeedsApprovalAttention('paused', 'running')).toBe(false);
  });
});

describe('team unified runtime control paths', () => {
  it('keeps max_turns as non-completed team state', async () => {
    const projectRoot = makeTmpDir();
    try {
      const result = await executeTeamDelegatedRuntime({
        projectRoot,
        runId: 'run-max-turns',
        workspaceId: 'ws-max-turns',
        taskId: 'task-max-turns',
        taskKind: 'compute',
        ownerRole: 'lead',
        delegateRole: 'delegate',
        delegateId: 'delegate-1',
        coordinationPolicy: 'supervised_delegate',
        permissions: PERMISSIONS,
        messages: [{ role: 'user', content: 'go' }],
        tools: [{ name: 'do_thing', input_schema: { type: 'object', properties: {} } }],
        model: 'claude-opus-4-6',
        maxTurns: 1,
        mcpClient: { callTool: vi.fn(async () => ({ ok: true, isError: false, rawText: 'tool-result', json: null, errorCode: null })) },
        approvalGate: { createPending: () => ({}) } as never,
        _messagesCreate: vi.fn().mockResolvedValue(toolUseResponse('tu_loop', 'do_thing')),
      });

      expect(result.events.at(-1)).toMatchObject({ type: 'done', stopReason: 'max_turns' });
      expect(result.team_state.delegate_assignments[0]?.status).toBe('running');
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it('maps diminishing_returns guard stop to needs_recovery team state', async () => {
    const projectRoot = makeTmpDir();
    try {
      const result = await executeTeamDelegatedRuntime({
        projectRoot,
        runId: 'run-diminishing-returns',
        workspaceId: 'ws-diminishing-returns',
        taskId: 'task-diminishing-returns',
        taskKind: 'compute',
        ownerRole: 'lead',
        delegateRole: 'delegate',
        delegateId: 'delegate-1',
        coordinationPolicy: 'supervised_delegate',
        permissions: PERMISSIONS,
        messages: [{ role: 'user', content: 'loop until diminishing returns guard triggers' }],
        tools: [{ name: 'do_thing', input_schema: { type: 'object', properties: {} } }],
        model: 'claude-opus-4-6',
        maxTurns: 10,
        mcpClient: { callTool: vi.fn(async () => ({ ok: true, isError: false, rawText: 'tool-result', json: null, errorCode: null })) },
        approvalGate: { createPending: () => ({}) } as never,
        _messagesCreate: vi.fn().mockResolvedValue(toolUseResponse('tu_loop', 'do_thing')),
      });

      expect(result.events.at(-1)).toMatchObject({ type: 'done', stopReason: 'diminishing_returns' });
      expect(result.team_state.delegate_assignments[0]?.status).toBe('needs_recovery');
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it('persists canonical research-task refs in the sidecar registry without widening public team payloads', async () => {
    const projectRoot = makeTmpDir();
    try {
      const researchTaskRef = {
        task_id: 'task-task-ref',
        task_kind: 'draft_update' as const,
        target_node_id: 'draft:node-1',
        parent_task_id: null,
        workspace_id: 'workspace:run-task-ref',
        handoff_id: 'handoff-writing-1',
        handoff_kind: 'writing' as const,
        source_task_id: 'task-finding-1',
      };
      primeDelegatedFollowupTeamState({
        projectRoot,
        runId: 'run-task-ref',
        team: {
          workspace_id: 'workspace:run-task-ref',
          owner_role: 'lead',
          delegate_role: 'delegate',
          delegate_id: 'delegate-1',
          coordination_policy: 'supervised_delegate',
          task_id: 'task-task-ref',
          task_kind: 'draft_update',
          research_task_ref: researchTaskRef,
          handoff_id: 'handoff-writing-1',
          handoff_kind: 'writing',
          checkpoint_id: null,
        },
      });

      const primedRegistry = new TeamExecutionStateManager(projectRoot).loadTaskRefRegistry('run-task-ref');
      expect(primedRegistry?.refs_by_task_id['task-task-ref']).toEqual(researchTaskRef);

      const result = await executeUnifiedTeamRuntime({
        projectRoot,
        runId: 'run-task-ref',
        workspaceId: 'workspace:run-task-ref',
        coordinationPolicy: 'supervised_delegate',
        permissions: {
          delegation: [{
            from_role: 'lead',
            to_role: 'delegate',
            allowed_task_kinds: ['draft_update'],
            allowed_handoff_kinds: ['writing'],
          }],
          interventions: PERMISSIONS.interventions,
        },
        assignments: [{
          stage: 0,
          owner_role: 'lead',
          delegate_role: 'delegate',
          delegate_id: 'delegate-1',
          task_id: 'task-task-ref',
          task_kind: 'draft_update',
          handoff_id: 'handoff-writing-1',
          handoff_kind: 'writing',
        }],
        messages: [{ role: 'user', content: 'draft this section' }],
        tools: [{ name: 'orch_run_stage_content', input_schema: { type: 'object', properties: {} } }],
        model: 'claude-opus-4-6',
        mcpClient: { callTool: vi.fn(async () => ({
          ok: true,
          isError: false,
          rawText: JSON.stringify({
            run_id: 'run-task-ref',
            artifact_name: 'staged_section_output_task-task-ref.json',
            staging_uri: 'rep://runs/run-task-ref/artifact/artifacts%2Fstaged_section_output_task-task-ref.json',
            content_bytes: 42,
          }),
          json: {
            run_id: 'run-task-ref',
            artifact_name: 'staged_section_output_task-task-ref.json',
            staging_uri: 'rep://runs/run-task-ref/artifact/artifacts%2Fstaged_section_output_task-task-ref.json',
            content_bytes: 42,
          },
          errorCode: null,
        })) },
        approvalGate: { createPending: () => ({}) } as never,
        _messagesCreate: vi.fn()
          .mockImplementationOnce(async params => {
            const protocol = extractProtocolText(params);
            expect(protocol).toContain('orch_run_stage_content');
            expect(protocol).toContain('task_id=task-task-ref');
            expect(protocol).toContain('content_type=section_output');
            return toolUseResponse('tu_task_ref', 'orch_run_stage_content', {
              run_id: 'run-task-ref',
              run_dir: path.join(projectRoot, 'run-task-ref'),
              content_type: 'section_output',
              content: '{"title":"draft"}',
              task_id: 'task-task-ref',
              task_kind: 'draft_update',
            });
          })
          .mockResolvedValueOnce(textResponse('done')),
      });

      const registry = new TeamExecutionStateManager(projectRoot).loadTaskRefRegistry('run-task-ref');
      const assignmentId = result.team_state.delegate_assignments[0]!.assignment_id;
      const checkpointId = result.team_state.checkpoints[0]!.checkpoint_id;
      const sessionId = result.team_state.sessions[0]!.session_id;

      expect(registry?.refs_by_task_id['task-task-ref']).toEqual(researchTaskRef);
      expect(registry?.refs_by_assignment_id[assignmentId]).toEqual(researchTaskRef);
      expect(registry?.refs_by_checkpoint_id[checkpointId]).toEqual(researchTaskRef);
      expect(registry?.refs_by_session_id[sessionId]).toEqual(researchTaskRef);

      expect(result.team_state.delegate_assignments[0]).not.toHaveProperty('research_task_ref');
      expect(result.team_state.sessions[0]).not.toHaveProperty('research_task_ref');
      expect(result.team_state.checkpoints[0]).not.toHaveProperty('research_task_ref');
      expect(result.live_status.terminal_assignments[0]).not.toHaveProperty('research_task_ref');
      expect(result.live_status.background_tasks[0]).not.toHaveProperty('research_task_ref');
      expect(result.replay[0]).not.toHaveProperty('research_task_ref');
      expect(result.assignment_results[0]).not.toHaveProperty('research_task_ref');
      expect(result.team_state.sessions[0]).not.toHaveProperty('delegated_runtime_handle');
      expect(result.live_status.terminal_assignments[0]).not.toHaveProperty('delegated_runtime_handle');
      expect(result.replay[0]).not.toHaveProperty('delegated_runtime_handle');
      expect(result.assignment_results[0]).not.toHaveProperty('delegated_runtime_handle');
      expect(result.assignment_results[0]?.status).toBe('completed');
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it('marks delegated draft follow-up assignments as needs_recovery when they finish without task-scoped output submission', async () => {
    const projectRoot = makeTmpDir();
    try {
      primeDelegatedFollowupTeamState({
        projectRoot,
        runId: 'run-missing-draft-output',
        team: {
          workspace_id: 'workspace:run-missing-draft-output',
          owner_role: 'lead',
          delegate_role: 'delegate',
          delegate_id: 'delegate-1',
          coordination_policy: 'supervised_delegate',
          task_id: 'task-draft-followup',
          task_kind: 'draft_update',
          research_task_ref: {
            task_id: 'task-draft-followup',
            task_kind: 'draft_update',
            target_node_id: 'draft:node-1',
            parent_task_id: null,
            workspace_id: 'workspace:run-missing-draft-output',
            handoff_id: 'handoff-writing-1',
            handoff_kind: 'writing',
            source_task_id: 'task-finding-1',
          },
          handoff_id: 'handoff-writing-1',
          handoff_kind: 'writing',
          checkpoint_id: null,
        },
      });

      const result = await executeUnifiedTeamRuntime({
        projectRoot,
        runId: 'run-missing-draft-output',
        workspaceId: 'workspace:run-missing-draft-output',
        coordinationPolicy: 'supervised_delegate',
        permissions: {
          delegation: [{
            from_role: 'lead',
            to_role: 'delegate',
            allowed_task_kinds: ['draft_update'],
            allowed_handoff_kinds: ['writing'],
          }],
          interventions: PERMISSIONS.interventions,
        },
        assignments: [{
          stage: 0,
          owner_role: 'lead',
          delegate_role: 'delegate',
          delegate_id: 'delegate-1',
          task_id: 'task-draft-followup',
          task_kind: 'draft_update',
          handoff_id: 'handoff-writing-1',
          handoff_kind: 'writing',
        }],
        messages: [{ role: 'user', content: 'draft this section' }],
        tools: [],
        model: 'claude-opus-4-6',
        mcpClient: { callTool: vi.fn(async () => ({ ok: true, isError: false, rawText: 'unused', json: null, errorCode: null })) },
        approvalGate: { createPending: () => ({}) } as never,
        _messagesCreate: vi.fn().mockResolvedValue(textResponse('done')),
      });

      expect(result.assignment_results[0]?.status).toBe('needs_recovery');
      expect(result.replay.some(entry =>
        entry.kind === 'assignment_status_changed'
        && entry.payload.status === 'needs_recovery'
        && entry.payload.reason === 'missing_task_scoped_output',
      )).toBe(true);
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it('marks delegated review follow-up assignments as needs_recovery when they omit judge_decision output', async () => {
    const projectRoot = makeTmpDir();
    try {
      const runId = 'run-review-missing-decision';
      const runDir = ensureRunDir(projectRoot, runId);
      primeDelegatedFollowupTeamState({
        projectRoot,
        runId,
        team: {
          workspace_id: `workspace:${runId}`,
          owner_role: 'lead',
          delegate_role: 'delegate',
          delegate_id: 'delegate-1',
          coordination_policy: 'supervised_delegate',
          task_id: 'task-review-followup',
          task_kind: 'review',
          research_task_ref: {
            task_id: 'task-review-followup',
            task_kind: 'review',
            target_node_id: 'review:node-1',
            parent_task_id: null,
            workspace_id: `workspace:${runId}`,
            handoff_id: 'handoff-review-1',
            handoff_kind: 'review',
            source_task_id: 'task-draft-1',
          },
          handoff_id: 'handoff-review-1',
          handoff_kind: 'review',
          checkpoint_id: null,
        },
      });

      const result = await executeUnifiedTeamRuntime({
        projectRoot,
        runId,
        workspaceId: `workspace:${runId}`,
        coordinationPolicy: 'supervised_delegate',
        permissions: {
          delegation: [{
            from_role: 'lead',
            to_role: 'delegate',
            allowed_task_kinds: ['review'],
            allowed_handoff_kinds: ['review'],
          }],
          interventions: PERMISSIONS.interventions,
        },
        assignments: [{
          stage: 0,
          owner_role: 'lead',
          delegate_role: 'delegate',
          delegate_id: 'delegate-1',
          task_id: 'task-review-followup',
          task_kind: 'review',
          handoff_id: 'handoff-review-1',
          handoff_kind: 'review',
        }],
        messages: [{ role: 'user', content: 'review this draft' }],
        tools: [{ name: 'orch_run_stage_content', input_schema: { type: 'object', properties: {} } }],
        model: 'claude-opus-4-6',
        mcpClient: { callTool: vi.fn(async (_name, args) => {
          const payload = stageContentInRunDir({
            runId,
            runDir,
            contentType: args.content_type as 'reviewer_report',
            content: String(args.content),
            taskId: args.task_id as string,
            taskKind: args.task_kind as 'review',
          });
          return {
            ok: true,
            isError: false,
            rawText: JSON.stringify(payload),
            json: payload,
            errorCode: null,
          };
        }) },
        approvalGate: { createPending: () => ({}) } as never,
        _messagesCreate: vi.fn()
          .mockImplementationOnce(async params => {
            const protocol = extractProtocolText(params);
            expect(protocol).toContain('orch_run_stage_content');
            expect(protocol).toContain('task_id=task-review-followup');
            expect(protocol).toMatch(/content_type=reviewer_report or revision_plan/);
            expect(protocol).toContain('content_type=judge_decision');
            return toolUseResponse('tu_review_ref', 'orch_run_stage_content', {
              run_id: runId,
              run_dir: runDir,
              content_type: 'reviewer_report',
              content: '{"summary":"review"}',
              task_id: 'task-review-followup',
              task_kind: 'review',
            });
          })
          .mockResolvedValueOnce(textResponse('done')),
      });

      expect(result.assignment_results[0]?.status).toBe('needs_recovery');
      expect(result.replay.some(entry =>
        entry.kind === 'assignment_status_changed'
        && entry.payload.status === 'needs_recovery'
        && entry.payload.reason === 'missing_task_scoped_output',
      )).toBe(true);
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it('keeps delegated review follow-up assignments on the completed path when they submit narrative review output plus judge_decision(accept)', async () => {
    const projectRoot = makeTmpDir();
    try {
      const runId = 'run-review-output';
      const { runDir, reviewNodeId, workspaceId } = await prepareReviewLoweringRun(projectRoot, runId);
      primeDelegatedFollowupTeamState({
        projectRoot,
        runId,
        team: {
          workspace_id: workspaceId,
          owner_role: 'lead',
          delegate_role: 'delegate',
          delegate_id: 'delegate-1',
          coordination_policy: 'supervised_delegate',
          task_id: 'task-review-followup',
          task_kind: 'review',
          research_task_ref: {
            task_id: 'task-review-followup',
            task_kind: 'review',
            target_node_id: reviewNodeId,
            parent_task_id: null,
            workspace_id: workspaceId,
            handoff_id: 'handoff-review-1',
            handoff_kind: 'review',
            source_task_id: 'task-draft-1',
          },
          handoff_id: 'handoff-review-1',
          handoff_kind: 'review',
          checkpoint_id: null,
        },
      });

      const result = await executeUnifiedTeamRuntime({
        projectRoot,
        runId,
        workspaceId,
        coordinationPolicy: 'supervised_delegate',
        permissions: {
          delegation: [{
            from_role: 'lead',
            to_role: 'delegate',
            allowed_task_kinds: ['review'],
            allowed_handoff_kinds: ['review'],
          }],
          interventions: PERMISSIONS.interventions,
        },
        assignments: [{
          stage: 0,
          owner_role: 'lead',
          delegate_role: 'delegate',
          delegate_id: 'delegate-1',
          task_id: 'task-review-followup',
          task_kind: 'review',
          handoff_id: 'handoff-review-1',
          handoff_kind: 'review',
        }],
        messages: [{ role: 'user', content: 'review this draft' }],
        tools: [{ name: 'orch_run_stage_content', input_schema: { type: 'object', properties: {} } }],
        model: 'claude-opus-4-6',
        mcpClient: { callTool: vi.fn(async (_name, args) => {
          const payload = stageContentInRunDir({
            runId,
            runDir,
            contentType: args.content_type as 'reviewer_report' | 'judge_decision',
            content: String(args.content),
            taskId: args.task_id as string,
            taskKind: args.task_kind as 'review',
          });
          return {
            ok: true,
            isError: false,
            rawText: JSON.stringify(payload),
            json: payload,
            errorCode: null,
          };
        }) },
        approvalGate: { createPending: () => ({}) } as never,
        _messagesCreate: vi.fn()
          .mockImplementationOnce(async params => {
            const protocol = extractProtocolText(params);
            expect(protocol).toContain('content_type=judge_decision');
            return toolUseResponse('tu_review_report', 'orch_run_stage_content', {
              run_id: runId,
              run_dir: runDir,
              content_type: 'reviewer_report',
              content: '{"summary":"review"}',
              task_id: 'task-review-followup',
              task_kind: 'review',
            });
          })
          .mockImplementationOnce(async () => toolUseResponse('tu_judge_decision', 'orch_run_stage_content', {
            run_id: runId,
            run_dir: runDir,
            content_type: 'judge_decision',
            content: '{"schema_version":1,"disposition":"accept","reason":"No more evidence required."}',
            task_id: 'task-review-followup',
            task_kind: 'review',
          }))
          .mockResolvedValueOnce(textResponse('done')),
      });

      expect(result.assignment_results[0]?.status).toBe('completed');
      expect(result.team_state.delegate_assignments).toHaveLength(1);
      expect(result.replay.some(entry =>
        entry.kind === 'assignment_status_changed'
        && entry.payload.status === 'completed'
        && entry.payload.review_followup_disposition === 'accept',
      )).toBe(true);
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it('lowers delegated review follow-up judge_decision(request_evidence_search) into a pending evidence_search assignment', async () => {
    const projectRoot = makeTmpDir();
    try {
      const runId = 'run-review-evidence-search';
      const { runDir, reviewNodeId, evidenceNodeId, workspaceId } = await prepareReviewLoweringRun(projectRoot, runId);
      primeDelegatedFollowupTeamState({
        projectRoot,
        runId,
        team: {
          workspace_id: workspaceId,
          owner_role: 'lead',
          delegate_role: 'delegate',
          delegate_id: 'delegate-1',
          coordination_policy: 'supervised_delegate',
          task_id: 'task-review-followup',
          task_kind: 'review',
          research_task_ref: {
            task_id: 'task-review-followup',
            task_kind: 'review',
            target_node_id: reviewNodeId,
            parent_task_id: null,
            workspace_id: workspaceId,
            handoff_id: 'handoff-review-1',
            handoff_kind: 'review',
            source_task_id: 'task-draft-1',
          },
          handoff_id: 'handoff-review-1',
          handoff_kind: 'review',
          checkpoint_id: null,
        },
      });

      const result = await executeUnifiedTeamRuntime({
        projectRoot,
        runId,
        workspaceId,
        coordinationPolicy: 'supervised_delegate',
        permissions: {
          delegation: [{
            from_role: 'lead',
            to_role: 'delegate',
            allowed_task_kinds: ['review', 'evidence_search'],
            allowed_handoff_kinds: ['review', 'literature'],
          }],
          interventions: PERMISSIONS.interventions,
        },
        assignments: [{
          stage: 0,
          owner_role: 'lead',
          delegate_role: 'delegate',
          delegate_id: 'delegate-1',
          task_id: 'task-review-followup',
          task_kind: 'review',
          handoff_id: 'handoff-review-1',
          handoff_kind: 'review',
        }],
        messages: [{ role: 'user', content: 'review this draft' }],
        tools: [{ name: 'orch_run_stage_content', input_schema: { type: 'object', properties: {} } }],
        model: 'claude-opus-4-6',
        mcpClient: { callTool: vi.fn(async (_name, args) => {
          const payload = stageContentInRunDir({
            runId,
            runDir,
            contentType: args.content_type as 'reviewer_report' | 'judge_decision',
            content: String(args.content),
            taskId: args.task_id as string,
            taskKind: args.task_kind as 'review',
          });
          return {
            ok: true,
            isError: false,
            rawText: JSON.stringify(payload),
            json: payload,
            errorCode: null,
          };
        }) },
        approvalGate: { createPending: () => ({}) } as never,
        _messagesCreate: vi.fn()
          .mockImplementationOnce(async () => toolUseResponse('tu_review_report', 'orch_run_stage_content', {
            run_id: runId,
            run_dir: runDir,
            content_type: 'reviewer_report',
            content: '{"summary":"review"}',
            task_id: 'task-review-followup',
            task_kind: 'review',
          }))
          .mockImplementationOnce(async () => toolUseResponse('tu_judge_decision', 'orch_run_stage_content', {
            run_id: runId,
            run_dir: runDir,
            content_type: 'judge_decision',
            content: JSON.stringify({
              schema_version: 1,
              disposition: 'request_evidence_search',
              reason: 'Need stronger support.',
              query: 'targeted evidence refresh',
              target_evidence_node_id: evidenceNodeId,
            }),
            task_id: 'task-review-followup',
            task_kind: 'review',
          }))
          .mockResolvedValueOnce(textResponse('done')),
      });

      expect(result.assignment_results[0]?.status).toBe('completed');
      expect(result.team_state.delegate_assignments).toHaveLength(2);
      const reviewAssignment = result.team_state.delegate_assignments.find(item => item.task_id === 'task-review-followup')!;
      const evidenceAssignment = result.team_state.delegate_assignments.find(item => item.task_kind === 'evidence_search')!;
      expect(evidenceAssignment.status).toBe('pending');
      expect(evidenceAssignment.handoff_kind).toBe('literature');
      expect(evidenceAssignment.handoff_payload).toEqual({
        query: 'targeted evidence refresh',
        reason: 'review_followup',
      });
      expect(evidenceAssignment.forked_from_assignment_id).toBe(reviewAssignment.assignment_id);
      const registry = new TeamExecutionStateManager(projectRoot).loadTaskRefRegistry(runId);
      expect(registry?.refs_by_task_id[evidenceAssignment.task_id]).toMatchObject({
        task_id: evidenceAssignment.task_id,
        task_kind: 'evidence_search',
        target_node_id: evidenceNodeId,
        source_task_id: 'task-review-followup',
      });
      expect(result.replay.some(entry =>
        entry.kind === 'assignment_status_changed'
        && entry.payload.status === 'completed'
        && entry.payload.review_followup_disposition === 'request_evidence_search'
        && entry.payload.spawned_task_kind === 'evidence_search',
      )).toBe(true);
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it('keeps non-delegated review assignments on the existing completion semantics', async () => {
    const projectRoot = makeTmpDir();
    try {
      const result = await executeUnifiedTeamRuntime({
        projectRoot,
        runId: 'run-plain-review',
        workspaceId: 'workspace:run-plain-review',
        coordinationPolicy: 'supervised_delegate',
        permissions: PERMISSIONS,
        assignments: [{
          stage: 0,
          owner_role: 'lead',
          delegate_role: 'delegate',
          delegate_id: 'delegate-1',
          task_id: 'task-review-plain',
          task_kind: 'review',
          handoff_id: null,
          handoff_kind: null,
        }],
        messages: [{ role: 'user', content: 'review this' }],
        tools: [],
        model: 'claude-opus-4-6',
        mcpClient: { callTool: vi.fn(async () => ({ ok: true, isError: false, rawText: 'unused', json: null, errorCode: null })) },
        approvalGate: { createPending: () => ({}) } as never,
        _messagesCreate: vi.fn().mockResolvedValue(textResponse('plain review complete')),
      });

      expect(result.assignment_results[0]?.status).toBe('completed');
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it('respects pause and cascade_stop interventions through structured team state', async () => {
    const projectRoot = makeTmpDir();
    try {
      const paused = await executeTeamDelegatedRuntime({
        projectRoot,
        runId: 'run-pause',
        workspaceId: 'ws-pause',
        taskId: 'task-pause',
        taskKind: 'compute',
        ownerRole: 'lead',
        delegateRole: 'delegate',
        delegateId: 'delegate-1',
        coordinationPolicy: 'supervised_delegate',
        permissions: PERMISSIONS,
        messages: [{ role: 'user', content: 'go' }],
        tools: [{ name: 'do_thing', input_schema: { type: 'object', properties: {} } }],
        model: 'claude-opus-4-6',
        interventions: [{ kind: 'pause', scope: 'task', actor_role: 'lead', actor_id: 'pi', task_id: 'task-pause' }],
        mcpClient: { callTool: vi.fn(async () => ({ ok: true, isError: false, rawText: 'x', json: null, errorCode: null })) },
        approvalGate: { createPending: () => ({}) } as never,
        _messagesCreate: vi.fn().mockResolvedValue(textResponse('done')),
      });
      expect(paused.events).toEqual([]);
      expect(paused.team_state.delegate_assignments[0]?.status).toBe('paused');

      const cascade = await executeTeamDelegatedRuntime({
        projectRoot,
        runId: 'run-cascade',
        workspaceId: 'ws-cascade',
        taskId: 'task-cascade',
        taskKind: 'compute',
        ownerRole: 'lead',
        delegateRole: 'delegate',
        delegateId: 'delegate-1',
        coordinationPolicy: 'parallel',
        permissions: PERMISSIONS,
        messages: [{ role: 'user', content: 'go' }],
        tools: [{ name: 'do_thing', input_schema: { type: 'object', properties: {} } }],
        model: 'claude-opus-4-6',
        interventions: [{ kind: 'cascade_stop', scope: 'team', actor_role: 'lead', actor_id: 'pi', note: 'stop all delegates' }],
        mcpClient: { callTool: vi.fn(async () => ({ ok: true, isError: false, rawText: 'x', json: null, errorCode: null })) },
        approvalGate: { createPending: () => ({}) } as never,
        _messagesCreate: vi.fn().mockResolvedValue(textResponse('done')),
      });

      expect(cascade.team_state.interventions.at(-1)?.kind).toBe('cascade_stop');
      expect(cascade.team_state.delegate_assignments[0]?.status).toBe('cascade_stopped');
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it('persists nested approval metadata and resumes after a task-scoped approve intervention', async () => {
    const projectRoot = makeTmpDir();
    try {
      const approvalClient = vi.fn(async () => ({
        ok: true,
        isError: false,
        rawText: '{"requires_approval":true,"approval_id":"apr_nested","packet_path":"artifacts/runs/run-approval/approval_packet_v1.json"}',
        json: {
          requires_approval: true,
          approval_id: 'apr_nested',
          packet_path: 'artifacts/runs/run-approval/approval_packet_v1.json',
        },
        errorCode: null,
      }));

      const first = await executeUnifiedTeamRuntime({
        projectRoot,
        runId: 'run-approval',
        workspaceId: 'workspace:run-approval',
        coordinationPolicy: 'supervised_delegate',
        permissions: PERMISSIONS,
        assignments: [
          { stage: 0, owner_role: 'lead', delegate_role: 'delegate', delegate_id: 'delegate-1', task_id: 'task-approval', task_kind: 'compute' },
        ],
        messages: [{ role: 'user', content: 'go' }],
        tools: [{ name: 'do_thing', input_schema: { type: 'object', properties: {} } }],
        model: 'claude-opus-4-6',
        mcpClient: { callTool: approvalClient },
        approvalGate: { createPending: () => ({}) } as never,
        _messagesCreate: vi.fn().mockResolvedValue(toolUseResponse('tu_approval', 'do_thing', { task_id: 'task-approval' })),
      });

      expect(first.assignment_results[0]?.status).toBe('awaiting_approval');
      expect(first.team_state.delegate_assignments[0]).toMatchObject({
        status: 'awaiting_approval',
        approval_id: 'apr_nested',
        approval_packet_path: 'artifacts/runs/run-approval/approval_packet_v1.json',
      });
      expect(first.team_state).not.toHaveProperty('pending_approvals');
      expect(first.team_state.sessions[0]).toMatchObject({
        agent_id: 'delegate-1',
        assignment_id: first.team_state.delegate_assignments[0]?.assignment_id,
        context_kind: 'fresh',
        runtime_status: 'awaiting_approval',
        task_lifecycle_status: 'running',
        task_status: 'active',
        runtime_projection: {
          approval_requested: true,
          terminal_outcome: {
            type: 'done',
            stop_reason: 'approval_required',
          },
        },
      });
      const firstSessionId = first.team_state.sessions[0]!.session_id;
      expect(first.live_status.pending_approvals[0]).toMatchObject({
        approval_id: 'apr_nested',
        agent_id: 'delegate-1',
        session_id: firstSessionId,
      });
      expect(first.live_status.background_tasks[0]).toMatchObject({
        agent_id: 'delegate-1',
        session_id: firstSessionId,
        session_context_kind: 'fresh',
        runtime_status: 'awaiting_approval',
        task_lifecycle_status: 'running',
        task_status: 'active',
      });

      const resumedCallTool = vi.fn(async () => ({
        ok: true,
        isError: false,
        rawText: 'should-not-run',
        json: null,
        errorCode: null,
      }));
      const resumed = await executeUnifiedTeamRuntime({
        projectRoot,
        runId: 'run-approval',
        workspaceId: 'workspace:run-approval',
        coordinationPolicy: 'supervised_delegate',
        permissions: PERMISSIONS,
        assignments: [
          { stage: 0, owner_role: 'lead', delegate_role: 'delegate', delegate_id: 'delegate-1', task_id: 'task-approval', task_kind: 'compute' },
        ],
        interventions: [{ kind: 'approve', scope: 'task', actor_role: 'lead', actor_id: 'pi', task_id: 'task-approval' }],
        messages: [
          { role: 'user', content: 'resume' },
          { role: 'assistant', content: [{ type: 'tool_use', id: 'tu_approval', name: 'do_thing', input: { task_id: 'task-approval' } }] },
        ],
        tools: [{ name: 'do_thing', input_schema: { type: 'object', properties: {} } }],
        model: 'claude-opus-4-6',
        mcpClient: { callTool: resumedCallTool },
        approvalGate: { createPending: () => ({}) } as never,
        _messagesCreate: vi.fn().mockResolvedValue(textResponse('approved and resumed')),
      });

      expect(resumed.assignment_results[0]?.status).toBe('completed');
      expect(resumed.assignment_results[0]?.resumed).toBe(true);
      expect(resumed.assignment_results[0]?.skipped_step_ids).toEqual(['tu_approval']);
      expect(resumed.team_state.delegate_assignments[0]).toMatchObject({
        status: 'completed',
        approval_id: null,
        approval_packet_path: null,
        approval_requested_at: null,
      });
      expect(resumed.team_state).not.toHaveProperty('pending_approvals');
      expect(resumed.team_state.sessions).toHaveLength(2);
      expect(resumed.team_state.sessions[1]).toMatchObject({
        parent_session_id: firstSessionId,
        context_kind: 'resumed',
        runtime_status: 'completed',
        task_lifecycle_status: 'completed',
        task_status: 'completed',
        runtime_projection: {
          recovery_turn_count: 1,
          terminal_outcome: {
            type: 'done',
            stop_reason: 'end_turn',
          },
        },
      });
      expect(resumed.live_status.pending_approvals).toEqual([]);
      expect(resumed.live_status.background_tasks[0]).toMatchObject({
        runtime_status: 'completed',
        task_lifecycle_status: 'completed',
        task_status: 'completed',
      });
      expect(resumedCallTool).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it('resolves delegated MCP/tool inheritance via typed state while staying permission-matrix bounded', async () => {
    const projectRoot = makeTmpDir();
    try {
      const createMessage = vi.fn(async params => {
        const taskId = extractTaskId(params);
        if (taskId === 'task-mcp-parent') {
          expect(params.tools.map((tool: { name: string }) => tool.name)).toEqual(['tool_a']);
        }
        if (taskId === 'task-mcp-child') {
          expect(params.tools.map((tool: { name: string }) => tool.name)).toEqual(['tool_a', 'tool_b']);
        }
        return textResponse(`${taskId} complete`);
      });

      const permissions: TeamPermissionMatrix = {
        delegation: [
          {
            from_role: 'lead',
            to_role: 'delegate',
            allowed_task_kinds: ['compute'],
            allowed_handoff_kinds: ['compute'],
            allowed_tool_names: ['tool_a'],
          },
          {
            from_role: 'lead',
            to_role: 'delegate_plus',
            allowed_task_kinds: ['compute'],
            allowed_handoff_kinds: ['compute'],
            allowed_tool_names: ['tool_a', 'tool_b'],
          },
        ],
        interventions: PERMISSIONS.interventions,
      };

      const result = await executeUnifiedTeamRuntime({
        projectRoot,
        runId: 'run-mcp-inherit',
        workspaceId: 'workspace:run-mcp-inherit',
        coordinationPolicy: 'sequential',
        permissions,
        assignments: [
          {
            assignment_id: 'assignment-mcp-parent',
            stage: 0,
            owner_role: 'lead',
            delegate_role: 'delegate',
            delegate_id: 'delegate-1',
            task_id: 'task-mcp-parent',
            task_kind: 'compute',
          },
          {
            assignment_id: 'assignment-mcp-child',
            stage: 1,
            owner_role: 'lead',
            delegate_role: 'delegate_plus',
            delegate_id: 'delegate-2',
            task_id: 'task-mcp-child',
            task_kind: 'compute',
            mcp_tool_inheritance: {
              mode: 'inherit_from_assignment',
              inherit_from_assignment_id: 'assignment-mcp-parent',
              additive_tool_names: ['tool_b'],
            },
          },
        ],
        messages: [{ role: 'user', content: 'go' }],
        tools: [
          { name: 'tool_a', input_schema: { type: 'object', properties: {} } },
          { name: 'tool_b', input_schema: { type: 'object', properties: {} } },
          { name: 'tool_c', input_schema: { type: 'object', properties: {} } },
        ],
        model: 'claude-opus-4-6',
        mcpClient: { callTool: vi.fn(async () => ({ ok: true, isError: false, rawText: 'unused', json: null, errorCode: null })) },
        approvalGate: { createPending: () => ({}) } as never,
        _messagesCreate: createMessage,
      });

      expect(result.assignment_results.map(item => item.task_id)).toEqual(['task-mcp-parent', 'task-mcp-child']);
      expect(result.assignment_results.every(item => item.status === 'completed')).toBe(true);
      expect(result.team_state.delegate_assignments[1]).toMatchObject({
        assignment_id: 'assignment-mcp-child',
        mcp_tool_inheritance: {
          mode: 'inherit_from_assignment',
          inherit_from_assignment_id: 'assignment-mcp-parent',
          additive_tool_names: ['tool_b'],
        },
      });
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it('injects redirect context into the next assignment launch and clears it after launch succeeds', async () => {
    const projectRoot = makeTmpDir();
    try {
      const createMessage = vi.fn(async params => {
        const redirectMessage = params.messages.find((message: { role: string; content: unknown }) =>
          message.role === 'user'
          && typeof message.content === 'string'
          && message.content.includes('## OPERATOR REDIRECT'),
        );
        expect(redirectMessage).toBeDefined();
        expect((redirectMessage as { content: string }).content).toContain('revise the computation plan');
        return textResponse('redirected run completed');
      });

      const result = await executeUnifiedTeamRuntime({
        projectRoot,
        runId: 'run-redirect',
        workspaceId: 'workspace:run-redirect',
        coordinationPolicy: 'supervised_delegate',
        permissions: PERMISSIONS,
        assignments: [
          { stage: 0, owner_role: 'lead', delegate_role: 'delegate', delegate_id: 'delegate-1', task_id: 'task-redirect', task_kind: 'compute' },
        ],
        interventions: [{
          kind: 'redirect',
          scope: 'task',
          actor_role: 'lead',
          actor_id: 'pi',
          task_id: 'task-redirect',
          note: 'revise the computation plan',
          payload: { focus: 'error budget', preserve_evidence: true },
        }],
        messages: [{ role: 'user', content: 'go' }],
        tools: [],
        model: 'claude-opus-4-6',
        mcpClient: { callTool: vi.fn(async () => ({ ok: true, isError: false, rawText: 'unused', json: null, errorCode: null })) },
        approvalGate: { createPending: () => ({}) } as never,
        _messagesCreate: createMessage,
      });

      expect(result.assignment_results[0]?.status).toBe('completed');
      expect(result.team_state.delegate_assignments[0]?.pending_redirect).toBeNull();
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it('runs injected follow-on assignments through the same unified runtime bucket planning', async () => {
    const projectRoot = makeTmpDir();
    try {
      const createMessage = vi.fn(async params => {
        const protocol = params.messages
          .filter((message: { role: string; content: unknown }) => message.role === 'user' && typeof message.content === 'string')
          .map((message: { content: string }) => message.content)
          .find((content: string) => content.includes('## TASK'));
        return textResponse(protocol?.includes('task-review-followup') ? 'review followup done' : 'seed compute done');
      });

      const result = await executeUnifiedTeamRuntime({
        projectRoot,
        runId: 'run-inject',
        workspaceId: 'workspace:run-inject',
        coordinationPolicy: 'stage_gated',
        permissions: PERMISSIONS,
        assignments: [
          { stage: 0, owner_role: 'lead', delegate_role: 'delegate', delegate_id: 'delegate-1', task_id: 'task-compute-seed', task_kind: 'compute', handoff_kind: 'compute' },
        ],
        interventions: [{
          kind: 'inject_task',
          scope: 'task',
          actor_role: 'lead',
          actor_id: 'pi',
          task_id: 'task-compute-seed',
          payload: {
            stage: 1,
            task_id: 'task-review-followup',
            task_kind: 'review',
            delegate_role: 'delegate',
            delegate_id: 'delegate-2',
            handoff_kind: 'review',
          },
        }],
        messages: [{ role: 'user', content: 'go' }],
        tools: [],
        model: 'claude-opus-4-6',
        mcpClient: { callTool: vi.fn(async () => ({ ok: true, isError: false, rawText: 'unused', json: null, errorCode: null })) },
        approvalGate: { createPending: () => ({}) } as never,
        _messagesCreate: createMessage,
      });

      expect(result.assignment_results.map(item => item.task_id)).toEqual(['task-compute-seed', 'task-review-followup']);
      expect(result.assignment_results.every(item => item.status === 'completed')).toBe(true);
      expect(result.team_state.delegate_assignments).toHaveLength(2);
      const [seed, followup] = result.team_state.delegate_assignments;
      expect(followup?.forked_from_assignment_id).toBe(seed?.assignment_id);
      expect(result.team_state.sessions.map(session => [session.assignment_id, session.context_kind])).toEqual([
        [seed?.assignment_id, 'fresh'],
        [followup?.assignment_id, 'forked'],
      ]);
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it('runs a real stage_gated multi-assignment path through the unified runtime core', async () => {
    const projectRoot = makeTmpDir();
    try {
      const createMessage = vi.fn(async params => {
        const protocol = params.messages
          .filter((message: { role: string; content: unknown }) => message.role === 'user' && typeof message.content === 'string')
          .map((message: { content: string }) => message.content)
          .find((content: string) => content.includes('## TASK'));
        return textResponse(protocol?.includes('task-review-2') ? 'review stage done' : 'compute stage done');
      });

      const result = await executeUnifiedTeamRuntime({
        projectRoot,
        runId: 'run-stage-gated',
        workspaceId: 'workspace:run-stage-gated',
        coordinationPolicy: 'stage_gated',
        permissions: PERMISSIONS,
        assignments: [
          { stage: 0, owner_role: 'lead', delegate_role: 'delegate', delegate_id: 'delegate-1', task_id: 'task-compute-1', task_kind: 'compute', handoff_id: 'handoff-compute-1', handoff_kind: 'compute' },
          { stage: 1, owner_role: 'lead', delegate_role: 'delegate', delegate_id: 'delegate-2', task_id: 'task-review-2', task_kind: 'review', handoff_id: 'handoff-review-2', handoff_kind: 'review' },
        ],
        messages: [{ role: 'user', content: 'go' }],
        tools: [],
        model: 'claude-opus-4-6',
        mcpClient: { callTool: vi.fn(async () => ({ ok: true, isError: false, rawText: 'unused', json: null, errorCode: null })) },
        approvalGate: { createPending: () => ({}) } as never,
        _messagesCreate: createMessage,
      });

      expect(result.assignment_results).toHaveLength(2);
      expect(result.assignment_results.map(item => item.task_id)).toEqual(['task-compute-1', 'task-review-2']);
      expect(result.assignment_results[0]?.delegation_protocol.TASK.task_id).toBe('task-compute-1');
      expect(result.blocked_stage).toBeNull();
      expect(result.live_status.active_assignments).toEqual([]);
      expect(result.live_status.terminal_assignments).toHaveLength(2);
      expect(result.replay.some(entry => entry.kind === 'stage_started' && entry.payload.stage === 0)).toBe(true);
      expect(result.replay.some(entry => entry.kind === 'stage_completed' && entry.payload.stage === 1)).toBe(true);
      expect(createMessage).toHaveBeenCalledTimes(2);
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it('fans out parallel assignments concurrently while keeping result ordering deterministic', async () => {
    const projectRoot = makeTmpDir();
    try {
      let releaseBarrier: (() => void) | null = null;
      const barrier = new Promise<void>(resolve => {
        releaseBarrier = resolve;
      });
      let readyResolve: (() => void) | null = null;
      const ready = new Promise<void>(resolve => {
        readyResolve = resolve;
      });
      const callOrder: string[] = [];

      const createMessage = vi.fn(async params => {
        const taskId = extractTaskId(params);
        const last = params.messages.at(-1);
        const hasToolResult = Boolean(
          last
            && last.role === 'user'
            && Array.isArray(last.content)
            && last.content.some(block => block.type === 'tool_result'),
        );
        return hasToolResult
          ? textResponse(`${taskId} complete`)
          : toolUseResponse(`tu_${taskId}`, 'do_thing', { task_id: taskId });
      });
      const callTool = vi.fn(async (_name: string, input: { task_id: string }) => {
        callOrder.push(input.task_id);
        if (callOrder.length === 2) readyResolve?.();
        await barrier;
        return { ok: true, isError: false, rawText: `tool:${input.task_id}`, json: null, errorCode: null };
      });

      const runtimePromise = executeUnifiedTeamRuntime({
        projectRoot,
        runId: 'run-parallel',
        workspaceId: 'workspace:run-parallel',
        coordinationPolicy: 'parallel',
        permissions: PERMISSIONS,
        assignments: [
          { stage: 0, owner_role: 'lead', delegate_role: 'delegate', delegate_id: 'delegate-1', task_id: 'task-parallel-1', task_kind: 'compute', handoff_id: 'handoff-parallel-1', handoff_kind: 'compute' },
          { stage: 1, owner_role: 'lead', delegate_role: 'delegate', delegate_id: 'delegate-2', task_id: 'task-parallel-2', task_kind: 'review', handoff_id: 'handoff-parallel-2', handoff_kind: 'review' },
        ],
        messages: [{ role: 'user', content: 'go' }],
        tools: [{ name: 'do_thing', input_schema: { type: 'object', properties: {} } }],
        model: 'claude-opus-4-6',
        mcpClient: { callTool },
        approvalGate: { createPending: () => ({}) } as never,
        _messagesCreate: createMessage,
      });

      const launched = await Promise.race([
        ready.then(() => true),
        new Promise<boolean>(resolve => setTimeout(() => resolve(false), 50)),
      ]);
      expect(launched).toBe(true);
      releaseBarrier?.();
      const result = await runtimePromise;

      expect(callTool).toHaveBeenCalledTimes(2);
      expect(callOrder.slice().sort()).toEqual(['task-parallel-1', 'task-parallel-2']);
      expect(result.assignment_results.map(item => item.task_id)).toEqual(['task-parallel-1', 'task-parallel-2']);
      expect(result.assignment_results.every(item => item.status === 'completed')).toBe(true);
      expect(result.live_status.terminal_assignments.map(item => item.task_id)).toEqual(['task-parallel-1', 'task-parallel-2']);
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it('keeps completed work terminal while resuming only recoverable parallel assignments', async () => {
    const projectRoot = makeTmpDir();
    try {
      const firstToolCall = vi.fn(async (_name: string, input: { task_id: string }) => ({
        ok: true,
        isError: false,
        rawText: `tool:${input.task_id}`,
        json: null,
        errorCode: null,
      }));
      const firstCreateMessage = vi.fn(async params => {
        const taskId = extractTaskId(params);
        const last = params.messages.at(-1);
        const hasToolResult = Boolean(
          last
            && last.role === 'user'
            && Array.isArray(last.content)
            && last.content.some(block => block.type === 'tool_result'),
        );
        if (taskId === 'task-recover-1') return textResponse('task-recover-1 complete');
        if (taskId === 'task-recover-2' && !hasToolResult) {
          return toolUseResponse('tu_recover', 'do_thing', { task_id: taskId });
        }
        if (taskId === 'task-recover-2' && hasToolResult) {
          throw new Error('interrupt after checkpoint');
        }
        return textResponse('expired assignment should not run');
      });

      const first = await executeUnifiedTeamRuntime({
        projectRoot,
        runId: 'run-recover-parallel',
        workspaceId: 'workspace:run-recover-parallel',
        coordinationPolicy: 'parallel',
        permissions: PERMISSIONS,
        assignments: [
          { stage: 0, owner_role: 'lead', delegate_role: 'delegate', delegate_id: 'delegate-1', task_id: 'task-recover-1', task_kind: 'compute', handoff_id: 'handoff-recover-1', handoff_kind: 'compute' },
          { stage: 1, owner_role: 'lead', delegate_role: 'delegate', delegate_id: 'delegate-2', task_id: 'task-recover-2', task_kind: 'review', handoff_id: 'handoff-recover-2', handoff_kind: 'review' },
          { stage: 2, owner_role: 'lead', delegate_role: 'delegate', delegate_id: 'delegate-3', task_id: 'task-timeout-3', task_kind: 'compute', handoff_id: 'handoff-timeout-3', handoff_kind: 'compute', timeout_at: '2020-01-01T00:00:00Z' },
        ],
        messages: [{ role: 'user', content: 'go' }],
        tools: [{ name: 'do_thing', input_schema: { type: 'object', properties: {} } }],
        model: 'claude-opus-4-6',
        mcpClient: { callTool: firstToolCall },
        approvalGate: { createPending: () => ({}) } as never,
        _messagesCreate: firstCreateMessage,
      });

      expect(first.assignment_results.map(item => [item.task_id, item.status])).toEqual([
        ['task-recover-1', 'completed'],
        ['task-recover-2', 'needs_recovery'],
        ['task-timeout-3', 'timed_out'],
      ]);
      expect(first.live_status.active_assignments.map(item => item.task_id)).toEqual(['task-recover-2']);
      expect(first.live_status.terminal_assignments.map(item => item.task_id).sort()).toEqual(['task-recover-1', 'task-timeout-3']);
      expect(first.live_status.terminal_assignments.find(item => item.task_id === 'task-timeout-3')?.timeout_at).toBe('2020-01-01T00:00:00Z');
      expect(first.replay.some(entry => entry.kind === 'assignment_timed_out')).toBe(true);
      expect(firstToolCall).toHaveBeenCalledTimes(1);

      const resumedToolCall = vi.fn(async () => ({
        ok: true,
        isError: false,
        rawText: 'should-not-run',
        json: null,
        errorCode: null,
      }));
      const resumedCreateMessage = vi.fn(async params => {
        const taskId = extractTaskId(params);
        return textResponse(`${taskId} resumed`);
      });

      const resumed = await executeUnifiedTeamRuntime({
        projectRoot,
        runId: 'run-recover-parallel',
        workspaceId: 'workspace:run-recover-parallel',
        coordinationPolicy: 'parallel',
        permissions: PERMISSIONS,
        assignments: [
          { stage: 0, owner_role: 'lead', delegate_role: 'delegate', delegate_id: 'delegate-1', task_id: 'task-recover-1', task_kind: 'compute', handoff_id: 'handoff-recover-1', handoff_kind: 'compute' },
          { stage: 1, owner_role: 'lead', delegate_role: 'delegate', delegate_id: 'delegate-2', task_id: 'task-recover-2', task_kind: 'review', handoff_id: 'handoff-recover-2', handoff_kind: 'review' },
          { stage: 2, owner_role: 'lead', delegate_role: 'delegate', delegate_id: 'delegate-3', task_id: 'task-timeout-3', task_kind: 'compute', handoff_id: 'handoff-timeout-3', handoff_kind: 'compute', timeout_at: '2020-01-01T00:00:00Z' },
        ],
        messages: [
          { role: 'user', content: 'resume' },
          { role: 'assistant', content: [{ type: 'tool_use', id: 'tu_recover', name: 'do_thing', input: { task_id: 'task-recover-2' } }] },
        ],
        tools: [{ name: 'do_thing', input_schema: { type: 'object', properties: {} } }],
        model: 'claude-opus-4-6',
        mcpClient: { callTool: resumedToolCall },
        approvalGate: { createPending: () => ({}) } as never,
        _messagesCreate: resumedCreateMessage,
      });

      expect(resumed.assignment_results.map(item => [item.task_id, item.status])).toEqual([
        ['task-recover-1', 'completed'],
        ['task-recover-2', 'completed'],
        ['task-timeout-3', 'timed_out'],
      ]);
      expect(resumedCreateMessage).toHaveBeenCalledTimes(1);
      expect(resumedToolCall).not.toHaveBeenCalled();
      expect(resumed.replay.filter(entry => entry.kind === 'checkpoint_restored')).toHaveLength(1);
      expect(resumed.live_status.active_assignments).toEqual([]);
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it('marks still-active recoverable assignments timed out only after concurrent bucket merges settle', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-21T00:00:00Z'));
    const projectRoot = makeTmpDir();
    try {
      const toolCall = vi.fn(async () => ({
        ok: true,
        isError: false,
        rawText: 'tool-result',
        json: null,
        errorCode: null,
      }));
      const createMessage = vi.fn(async params => {
        const taskId = extractTaskId(params);
        const last = params.messages.at(-1);
        const hasToolResult = Boolean(
          last
            && last.role === 'user'
            && Array.isArray(last.content)
            && last.content.some(block => block.type === 'tool_result'),
        );
        if (taskId === 'task-complete-1') {
          vi.setSystemTime(new Date('2026-03-21T00:01:00Z'));
          return textResponse('task-complete-1 complete');
        }
        if (!hasToolResult) {
          return toolUseResponse('tu_recover_timeout', 'do_thing', { task_id: taskId });
        }
        throw new Error('interrupt after checkpoint');
      });

      const result = await executeUnifiedTeamRuntime({
        projectRoot,
        runId: 'run-timeout-after-merge',
        workspaceId: 'workspace:run-timeout-after-merge',
        coordinationPolicy: 'parallel',
        permissions: PERMISSIONS,
        assignments: [
          { stage: 0, owner_role: 'lead', delegate_role: 'delegate', delegate_id: 'delegate-1', task_id: 'task-complete-1', task_kind: 'compute', handoff_id: 'handoff-complete-1', handoff_kind: 'compute' },
          { stage: 1, owner_role: 'lead', delegate_role: 'delegate', delegate_id: 'delegate-2', task_id: 'task-recover-timeout-2', task_kind: 'review', handoff_id: 'handoff-recover-timeout-2', handoff_kind: 'review', timeout_at: '2026-03-21T00:00:30Z' },
        ],
        messages: [{ role: 'user', content: 'go' }],
        tools: [{ name: 'do_thing', input_schema: { type: 'object', properties: {} } }],
        model: 'claude-opus-4-6',
        mcpClient: { callTool: toolCall },
        approvalGate: { createPending: () => ({}) } as never,
        _messagesCreate: createMessage,
      });

      expect(result.assignment_results.map(item => [item.task_id, item.status])).toEqual([
        ['task-complete-1', 'completed'],
        ['task-recover-timeout-2', 'timed_out'],
      ]);
      expect(result.replay.filter(entry => entry.kind === 'assignment_timed_out')).toHaveLength(1);
      expect(result.live_status.terminal_assignments.find(item => item.task_id === 'task-recover-timeout-2')?.status).toBe('timed_out');
    } finally {
      vi.useRealTimers();
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it('does not de-duplicate persisted assignments that differ by task kind', async () => {
    const projectRoot = makeTmpDir();
    try {
      const createMessage = vi.fn().mockResolvedValue(textResponse('done'));

      await executeUnifiedTeamRuntime({
        projectRoot,
        runId: 'run-dedup-task-kind',
        workspaceId: 'workspace:run-dedup-task-kind',
        coordinationPolicy: 'stage_gated',
        permissions: PERMISSIONS,
        assignments: [
          { stage: 0, owner_role: 'lead', delegate_role: 'delegate', delegate_id: 'delegate-1', task_id: 'task-shared', task_kind: 'compute' },
        ],
        messages: [{ role: 'user', content: 'go' }],
        tools: [],
        model: 'claude-opus-4-6',
        mcpClient: { callTool: vi.fn(async () => ({ ok: true, isError: false, rawText: 'unused', json: null, errorCode: null })) },
        approvalGate: { createPending: () => ({}) } as never,
        _messagesCreate: createMessage,
      });

      const rerun = await executeUnifiedTeamRuntime({
        projectRoot,
        runId: 'run-dedup-task-kind',
        workspaceId: 'workspace:run-dedup-task-kind',
        coordinationPolicy: 'stage_gated',
        permissions: PERMISSIONS,
        assignments: [
          { stage: 0, owner_role: 'lead', delegate_role: 'delegate', delegate_id: 'delegate-1', task_id: 'task-shared', task_kind: 'review' },
        ],
        messages: [{ role: 'user', content: 'go' }],
        tools: [],
        model: 'claude-opus-4-6',
        mcpClient: { callTool: vi.fn(async () => ({ ok: true, isError: false, rawText: 'unused', json: null, errorCode: null })) },
        approvalGate: { createPending: () => ({}) } as never,
        _messagesCreate: createMessage,
      });

      expect(rerun.team_state.delegate_assignments).toHaveLength(2);
      expect(rerun.team_state.delegate_assignments.map(item => item.task_kind).sort()).toEqual(['compute', 'review']);
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});
