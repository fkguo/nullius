import { describe, expect, it } from 'vitest';

import { handleToolCall } from '../../src/tools/index.js';
import { extractPayload, makeTmpDir } from './orchRunExecuteAgentTestSupport.js';

describe('orch_run_execute_agent team control-plane views', () => {
  it('returns unified live-status and replay views for a stage_gated multi-assignment team runtime', async () => {
    const projectRoot = makeTmpDir();
    await handleToolCall(
      'orch_run_create',
      { project_root: projectRoot, run_id: 'run-team-multi', workflow_id: 'runtime' },
      'full',
    );

    const payload = extractPayload(await handleToolCall(
      'orch_run_execute_agent',
      {
        _confirm: true,
        project_root: projectRoot,
        run_id: 'run-team-multi',
        model: 'claude-test',
        messages: [{ role: 'user', content: 'coordinate the team' }],
        tools: [],
        team: {
          workspace_id: 'workspace:run-team-multi',
          owner_role: 'lead',
          coordination_policy: 'stage_gated',
          assignments: [
            { stage: 0, task_id: 'task-compute-1', task_kind: 'compute', delegate_role: 'delegate', delegate_id: 'delegate-1', handoff_id: 'handoff-compute-1', handoff_kind: 'compute' },
            { stage: 1, task_id: 'task-review-2', task_kind: 'review', delegate_role: 'delegate', delegate_id: 'delegate-2', handoff_id: 'handoff-review-2', handoff_kind: 'review' },
          ],
        },
      },
      'full',
      {
        createMessage: async () => ({
          model: 'claude-test',
          role: 'assistant',
          content: { type: 'text', text: 'done' },
          stopReason: 'endTurn',
        }),
      },
    )) as {
      assignment_results: Array<{ task_id: string; stage: number }>;
      live_status: { terminal_assignments: Array<{ task_id: string }> };
      replay: Array<{ kind: string; payload: { stage?: number } }>;
    };

    expect(payload.assignment_results).toHaveLength(2);
    expect(payload.assignment_results.map(item => item.task_id)).toEqual(['task-compute-1', 'task-review-2']);
    expect(payload.live_status.terminal_assignments).toHaveLength(2);
    expect(payload.replay.some(entry => entry.kind === 'stage_started' && entry.payload.stage === 0)).toBe(true);
  });

  it('surfaces timed-out lifecycle fields through the live team control-plane view without launching the expired assignment', async () => {
    const projectRoot = makeTmpDir();
    await handleToolCall(
      'orch_run_create',
      { project_root: projectRoot, run_id: 'run-team-timeout', workflow_id: 'runtime' },
      'full',
    );
    let createMessageCalls = 0;
    let callToolCalls = 0;
    const payload = extractPayload(await handleToolCall(
      'orch_run_execute_agent',
      {
        _confirm: true,
        project_root: projectRoot,
        run_id: 'run-team-timeout',
        model: 'claude-test',
        messages: [{ role: 'user', content: 'coordinate the team' }],
        tools: [],
        team: {
          workspace_id: 'workspace:run-team-timeout',
          owner_role: 'lead',
          coordination_policy: 'parallel',
          assignments: [
            {
              stage: 0,
              task_id: 'task-timeout-1',
              task_kind: 'compute',
              delegate_role: 'delegate',
              delegate_id: 'delegate-1',
              handoff_id: 'handoff-timeout-1',
              handoff_kind: 'compute',
              timeout_at: '2020-01-01T00:00:00Z',
            },
          ],
        },
      },
      'full',
      {
        callTool: async () => {
          callToolCalls += 1;
          return { content: [{ type: 'text', text: 'should-not-run' }], isError: false };
        },
        createMessage: async () => {
          createMessageCalls += 1;
          return {
            model: 'claude-test',
            role: 'assistant',
            content: { type: 'text', text: 'done' },
            stopReason: 'endTurn',
          };
        },
      },
    )) as {
      assignment_results: Array<{ status: string }>;
      live_status: {
        terminal_assignments: Array<{ status: string; timeout_at: string | null; last_heartbeat_at: string | null }>;
      };
      replay: Array<{ kind: string }>;
    };

    expect(createMessageCalls).toBe(0);
    expect(callToolCalls).toBe(0);
    expect(payload.assignment_results[0]?.status).toBe('timed_out');
    expect(payload.live_status.terminal_assignments[0]).toMatchObject({
      status: 'timed_out',
      timeout_at: '2020-01-01T00:00:00Z',
      last_heartbeat_at: null,
    });
    expect(payload.replay.some(entry => entry.kind === 'assignment_timed_out')).toBe(true);
  });

  it('surfaces nested approval metadata through the live team control-plane view', async () => {
    const projectRoot = makeTmpDir();
    await handleToolCall(
      'orch_run_create',
      { project_root: projectRoot, run_id: 'run-team-approval-view', workflow_id: 'runtime' },
      'full',
    );

    const payload = extractPayload(await handleToolCall(
      'orch_run_execute_agent',
      {
        _confirm: true,
        project_root: projectRoot,
        run_id: 'run-team-approval-view',
        model: 'claude-test',
        messages: [{ role: 'user', content: 'coordinate the team' }],
        tools: [{
          name: 'do_thing',
          input_schema: {
            type: 'object',
            properties: {},
          },
        }],
        team: {
          workspace_id: 'workspace:run-team-approval-view',
          task_id: 'task-team-approval-view',
          task_kind: 'compute',
          owner_role: 'lead',
          delegate_role: 'delegate',
          delegate_id: 'delegate-1',
          coordination_policy: 'supervised_delegate',
        },
      },
      'full',
      {
        callTool: async () => ({
          content: [{
            type: 'text',
            text: JSON.stringify({
              requires_approval: true,
              approval_id: 'apr_view',
              packet_path: 'artifacts/runs/run-team-approval-view__nested/approval_packet_v1.json',
            }),
          }],
          isError: false,
        }),
        createMessage: async () => ({
          model: 'claude-test',
          role: 'assistant',
          content: {
            type: 'tool_use',
            id: 'tu_view',
            name: 'do_thing',
            input: {},
          },
          stopReason: 'tool_use',
        }),
      },
    )) as {
      live_status: {
        pending_approvals: Array<{
          approval_id: string;
          agent_id: string;
          assignment_id: string;
          session_id: string | null;
        }>;
        active_assignments: Array<{
          status: string;
          session_id: string | null;
          approval_id: string | null;
          approval_packet_path: string | null;
          approval_requested_at: string | null;
        }>;
        background_tasks: Array<{
          agent_id: string;
          session_id: string | null;
          runtime_status: string;
          task_lifecycle_status: string;
          task_status: string;
        }>;
      };
    };

    expect(payload.live_status.active_assignments[0]).toMatchObject({
      status: 'awaiting_approval',
      approval_id: 'apr_view',
      approval_packet_path: 'artifacts/runs/run-team-approval-view__nested/approval_packet_v1.json',
    });
    expect(payload.live_status.active_assignments[0]?.approval_requested_at).toBeTruthy();
    expect(payload.live_status.pending_approvals[0]).toMatchObject({
      approval_id: 'apr_view',
      agent_id: 'delegate-1',
      assignment_id: expect.any(String),
      session_id: payload.live_status.active_assignments[0]?.session_id ?? null,
    });
    expect(payload.live_status.background_tasks[0]).toMatchObject({
      agent_id: 'delegate-1',
      session_id: payload.live_status.active_assignments[0]?.session_id ?? null,
      runtime_status: 'awaiting_approval',
      task_lifecycle_status: 'running',
      task_status: 'active',
    });
  });
});
