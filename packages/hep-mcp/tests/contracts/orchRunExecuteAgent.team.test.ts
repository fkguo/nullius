import * as fs from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { ORCH_RUN_LIST, ORCH_RUN_STATUS } from '@autoresearch/shared';
import { primeDelegatedFollowupTeamState } from '@autoresearch/orchestrator';

import { handleToolCall } from '../../src/tools/index.js';
import { extractPayload, makeTmpDir } from './orchRunExecuteAgentTestSupport.js';

describe('orch_run_execute_agent team bridge', () => {
  it('persists team-local state for a realistic writing delegation payload and resumes from the saved checkpoint', async () => {
    const projectRoot = makeTmpDir();
    await handleToolCall(
      'orch_run_create',
      { project_root: projectRoot, run_id: 'run-team', workflow_id: 'runtime' },
      'full',
    );

    const runtimeArgs = {
      _confirm: true,
      project_root: projectRoot,
      run_id: 'run-team',
      model: 'claude-test',
      messages: [{
        role: 'assistant',
        content: [{
          type: 'tool_use',
          id: 'tu_write',
          name: 'do_thing',
          input: { section: 'results' },
        }],
      }],
      tools: [{
        name: 'do_thing',
        description: 'Perform a delegated writing action.',
        input_schema: {
          type: 'object',
          properties: {
            section: { type: 'string' },
          },
          required: ['section'],
        },
      }],
      team: {
        workspace_id: 'workspace:run-team',
        task_id: 'task-draft-update',
        task_kind: 'draft_update',
        owner_role: 'lead',
        delegate_role: 'delegate',
        delegate_id: 'delegate-1',
        coordination_policy: 'supervised_delegate',
        handoff_id: 'handoff-writing-1',
        handoff_kind: 'writing',
      },
    };
    primeDelegatedFollowupTeamState({
      projectRoot,
      runId: 'run-team',
      team: {
        workspace_id: 'workspace:run-team',
        task_id: 'task-draft-update',
        task_kind: 'draft_update',
        owner_role: 'lead',
        delegate_role: 'delegate',
        delegate_id: 'delegate-1',
        coordination_policy: 'supervised_delegate',
        research_task_ref: {
          task_id: 'task-draft-update',
          task_kind: 'draft_update',
          target_node_id: 'draft:results',
          parent_task_id: 'task-finding',
          workspace_id: 'workspace:run-team',
          handoff_id: 'handoff-writing-1',
          handoff_kind: 'writing',
          source_task_id: 'task-finding',
        },
        handoff_id: 'handoff-writing-1',
        handoff_kind: 'writing',
        checkpoint_id: null,
      },
    });

    const first = extractPayload(await handleToolCall(
      'orch_run_execute_agent',
      runtimeArgs,
      'full',
      {
        createMessage: async () => {
          throw new Error('interrupt after checkpoint');
        },
      },
    )) as {
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
        }>;
        checkpoints: Array<{
          checkpoint_id: string;
          task_id: string;
          handoff_id: string | null;
        }>;
        sessions: Array<{ session_id: string }>;
      };
      assignment_results: Array<Record<string, unknown>>;
      live_status: { background_tasks: Array<Record<string, unknown>> };
      replay: Array<Record<string, unknown>>;
    };
    expect(first.last_completed_step).toBe('tu_write');
    expect(first.team_state.workspace_id).toBe('workspace:run-team');
    expect(first.team_state.delegate_assignments[0]).toMatchObject({
      task_id: 'task-draft-update',
      task_kind: 'draft_update',
      handoff_id: 'handoff-writing-1',
      handoff_kind: 'writing',
    });
    expect(first.team_state.delegate_assignments[0]).not.toHaveProperty('research_task_ref');
    expect(first.team_state.checkpoints[0]).toMatchObject({
      task_id: 'task-draft-update',
      handoff_id: 'handoff-writing-1',
    });
    expect(first.team_state.checkpoints[0]).not.toHaveProperty('research_task_ref');
    expect(first.team_state.sessions[0]).not.toHaveProperty('research_task_ref');
    const registry = JSON.parse(
      fs.readFileSync(`${projectRoot}/artifacts/runs/run-team/team-execution-task-refs.json`, 'utf-8'),
    ) as {
      refs_by_task_id: Record<string, { source_task_id: string | null; handoff_id: string | null }>;
      refs_by_assignment_id: Record<string, { source_task_id: string | null; handoff_id: string | null }>;
      refs_by_checkpoint_id: Record<string, { source_task_id: string | null; handoff_id: string | null }>;
      refs_by_session_id: Record<string, { source_task_id: string | null; handoff_id: string | null }>;
    };
    expect(registry.refs_by_task_id['task-draft-update']).toMatchObject({
      source_task_id: 'task-finding',
      handoff_id: 'handoff-writing-1',
    });
    expect(registry.refs_by_assignment_id[first.team_state.delegate_assignments[0]!.assignment_id]).toMatchObject({
      source_task_id: 'task-finding',
      handoff_id: 'handoff-writing-1',
    });
    expect(registry.refs_by_checkpoint_id[first.team_state.checkpoints[0]!.checkpoint_id]).toMatchObject({
      source_task_id: 'task-finding',
      handoff_id: 'handoff-writing-1',
    });
    expect(registry.refs_by_session_id[first.team_state.sessions[0]!.session_id]).toMatchObject({
      source_task_id: 'task-finding',
      handoff_id: 'handoff-writing-1',
    });
    expect(first.assignment_results[0]).not.toHaveProperty('research_task_ref');
    expect(first.live_status.background_tasks[0]).not.toHaveProperty('research_task_ref');
    expect(first.replay[0]).not.toHaveProperty('research_task_ref');

    const resumedCallTool = vi.fn(async () => ({ content: [{ type: 'text', text: 'should-not-run' }], isError: false }));
    const resumed = extractPayload(await handleToolCall(
      'orch_run_execute_agent',
      runtimeArgs,
      'full',
      {
        callTool: resumedCallTool,
        createMessage: async () => ({
          model: 'claude-test',
          role: 'assistant',
          content: { type: 'text', text: 'resume completed' },
          stopReason: 'endTurn',
        }),
      },
    )) as {
      resumed: boolean;
      skipped_step_ids: string[];
      team_state: {
        checkpoints: Array<{ checkpoint_id: string; resume_from: string | null }>;
        delegate_assignments: Array<{ resume_from: string | null }>;
      };
    };
    expect(resumed.resumed).toBe(true);
    expect(resumed.skipped_step_ids).toEqual(['tu_write']);
    expect(resumed.team_state.delegate_assignments[0]?.resume_from).toBe('tu_write');
    expect(resumed.team_state.checkpoints[0]?.checkpoint_id).toBe(first.team_state.checkpoints[0]?.checkpoint_id);
    expect(resumed.team_state.checkpoints[0]?.resume_from).toBe('tu_write');
    expect(resumedCallTool).not.toHaveBeenCalled();
  });

  it('fails closed when the team permission matrix denies the delegated writing/review handoff', async () => {
    const projectRoot = makeTmpDir();
    await handleToolCall(
      'orch_run_create',
      { project_root: projectRoot, run_id: 'run-team-deny', workflow_id: 'runtime' },
      'full',
    );

    const denied = await handleToolCall(
      'orch_run_execute_agent',
      {
        _confirm: true,
        project_root: projectRoot,
        run_id: 'run-team-deny',
        model: 'claude-test',
        messages: [{ role: 'user', content: 'hello' }],
        tools: [],
        team: {
          workspace_id: 'workspace:run-team-deny',
          task_id: 'task-review',
          task_kind: 'review',
          owner_role: 'lead',
          delegate_role: 'delegate',
          delegate_id: 'delegate-1',
          coordination_policy: 'supervised_delegate',
          handoff_id: 'handoff-review-1',
          handoff_kind: 'review',
          permissions: {
            delegation: [{
              from_role: 'lead',
              to_role: 'delegate',
              allowed_task_kinds: ['draft_update'],
              allowed_handoff_kinds: ['writing'],
            }],
            interventions: [{
              actor_role: 'lead',
              allowed_scopes: ['task', 'team', 'project'],
              allowed_kinds: ['pause', 'resume', 'cancel', 'cascade_stop'],
            }],
          },
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
    );

    expect(denied.isError).toBe(true);
    const payload = extractPayload(denied);
    const error = payload.error as { message?: string };
    expect(error.message).toMatch(/delegation denied/i);
  });

  it('filters delegated tool visibility and blocks out-of-view tool calls through the shared host path', async () => {
    const projectRoot = makeTmpDir();
    await handleToolCall(
      'orch_run_create',
      { project_root: projectRoot, run_id: 'run-team-tool-filter', workflow_id: 'runtime' },
      'full',
    );

    let observedToolNames: string[] = [];
    const callTool = vi.fn(async () => ({ content: [{ type: 'text', text: 'should-not-run' }], isError: false }));
    const payload = extractPayload(await handleToolCall(
      'orch_run_execute_agent',
      {
        _confirm: true,
        project_root: projectRoot,
        run_id: 'run-team-tool-filter',
        model: 'claude-test',
        messages: [{ role: 'user', content: 'filter the delegated tools' }],
        tools: [
          {
            name: 'allowed_tool',
            input_schema: { type: 'object', properties: {} },
          },
          {
            name: 'blocked_tool',
            input_schema: { type: 'object', properties: {} },
          },
        ],
        team: {
          workspace_id: 'workspace:run-team-tool-filter',
          task_id: 'task-tool-filter',
          task_kind: 'draft_update',
          owner_role: 'lead',
          delegate_role: 'delegate',
          delegate_id: 'delegate-1',
          coordination_policy: 'supervised_delegate',
          permissions: {
            delegation: [{
              from_role: 'lead',
              to_role: 'delegate',
              allowed_task_kinds: ['draft_update'],
              allowed_handoff_kinds: ['writing'],
              allowed_tool_names: ['allowed_tool'],
            }],
            interventions: [{
              actor_role: 'lead',
              allowed_scopes: ['task', 'team'],
              allowed_kinds: ['pause', 'resume', 'cancel', 'cascade_stop'],
            }],
          },
        },
      },
      'full',
      {
        callTool,
        createMessage: async params => {
          observedToolNames = params.tools.map(tool => tool.name);
          return {
            model: 'claude-test',
            role: 'assistant',
            content: { type: 'tool_use', id: 'tu_blocked', name: 'blocked_tool', input: {} },
            stopReason: 'tool_use',
          };
        },
      },
    )) as {
      assignment_results: Array<{
        status: string;
        events: Array<{ type: string; error?: { code?: string; message?: string } }>;
      }>;
      team_state: {
        delegate_assignments: Array<{ status: string }>;
      };
    };

    expect(observedToolNames).toEqual(['allowed_tool']);
    expect(callTool).not.toHaveBeenCalled();
    expect(payload.assignment_results[0]?.status).toBe('failed');
    expect(payload.assignment_results[0]?.events).toMatchObject([
      {
        type: 'error',
        error: {
          code: 'INVALID_PARAMS',
          message: expect.stringContaining('blocked_tool'),
        },
      },
    ]);
    expect(payload.team_state.delegate_assignments[0]?.status).toBe('failed');
  });

  it('runs batch-safe read-only tool groups in parallel through the shared host path while preserving result order', async () => {
    const projectRoot = makeTmpDir();
    await handleToolCall(
      'orch_run_create',
      { project_root: projectRoot, run_id: 'run-team-batch-safe', workflow_id: 'runtime' },
      'full',
    );

    let resolveStatus!: (value: { content: Array<{ type: 'text'; text: string }>; isError: boolean }) => void;
    let resolveList!: (value: { content: Array<{ type: 'text'; text: string }>; isError: boolean }) => void;
    const statusResult = new Promise<{ content: Array<{ type: 'text'; text: string }>; isError: boolean }>(resolve => {
      resolveStatus = resolve;
    });
    const listResult = new Promise<{ content: Array<{ type: 'text'; text: string }>; isError: boolean }>(resolve => {
      resolveList = resolve;
    });
    const started: string[] = [];
    let createMessageCalls = 0;

    const resultPromise = handleToolCall(
      'orch_run_execute_agent',
      {
        _confirm: true,
        project_root: projectRoot,
        run_id: 'run-team-batch-safe',
        model: 'claude-test',
        messages: [{ role: 'user', content: 'inspect the runtime state' }],
        tools: [
          { name: ORCH_RUN_STATUS, input_schema: { type: 'object', properties: {} } },
          { name: ORCH_RUN_LIST, input_schema: { type: 'object', properties: {} } },
        ],
        team: {
          workspace_id: 'workspace:run-team-batch-safe',
          task_id: 'task-team-batch-safe',
          task_kind: 'draft_update',
          owner_role: 'lead',
          delegate_role: 'delegate',
          delegate_id: 'delegate-1',
          coordination_policy: 'supervised_delegate',
        },
      },
      'full',
      {
        callTool: async (name: string) => {
          started.push(name);
          if (name === ORCH_RUN_STATUS) return statusResult;
          if (name === ORCH_RUN_LIST) return listResult;
          return { content: [{ type: 'text', text: `unexpected:${name}` }], isError: false };
        },
        createMessage: async () => {
          createMessageCalls += 1;
          if (createMessageCalls === 1) {
            return {
              model: 'claude-test',
              role: 'assistant',
              content: [
                { type: 'tool_use', id: 'tu_status', name: ORCH_RUN_STATUS, input: {} },
                { type: 'tool_use', id: 'tu_list', name: ORCH_RUN_LIST, input: {} },
              ],
              stopReason: 'tool_use',
            };
          }
          return {
            model: 'claude-test',
            role: 'assistant',
            content: { type: 'text', text: 'batched tools complete' },
            stopReason: 'endTurn',
          };
        },
      },
    );

    for (let attempt = 0; attempt < 20 && started.length < 2; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 0));
    }
    expect(started).toEqual([ORCH_RUN_STATUS, ORCH_RUN_LIST]);

    resolveList({ content: [{ type: 'text', text: 'list-result' }], isError: false });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(createMessageCalls).toBe(1);

    resolveStatus({ content: [{ type: 'text', text: 'status-result' }], isError: false });
    const payload = extractPayload(await resultPromise) as {
      assignment_results: Array<{
        status: string;
        events: Array<{ type: string; name?: string; result?: string }>;
      }>;
    };

    expect(payload.assignment_results[0]?.status).toBe('completed');
    expect(payload.assignment_results[0]?.events.filter(event => event.type === 'tool_call')).toMatchObject([
      { type: 'tool_call', name: ORCH_RUN_STATUS, result: 'status-result' },
      { type: 'tool_call', name: ORCH_RUN_LIST, result: 'list-result' },
    ]);
  });

  it('surfaces nested approval metadata in team state and resumes after a task-scoped approve intervention', async () => {
    const projectRoot = makeTmpDir();
    await handleToolCall(
      'orch_run_create',
      { project_root: projectRoot, run_id: 'run-team-approval', workflow_id: 'runtime' },
      'full',
    );

    const runtimeArgs = {
      _confirm: true,
      project_root: projectRoot,
      run_id: 'run-team-approval',
      model: 'claude-test',
      messages: [{
        role: 'assistant',
        content: [{
          type: 'tool_use',
          id: 'tu_nested',
          name: 'do_thing',
          input: { section: 'results' },
        }],
      }],
      tools: [{
        name: 'do_thing',
        description: 'Perform a delegated writing action.',
        input_schema: {
          type: 'object',
          properties: {
            section: { type: 'string' },
          },
          required: ['section'],
        },
      }],
      team: {
        workspace_id: 'workspace:run-team-approval',
        task_id: 'task-team-approval',
        task_kind: 'draft_update',
        owner_role: 'lead',
        delegate_role: 'delegate',
        delegate_id: 'delegate-1',
        coordination_policy: 'supervised_delegate',
      },
    };

    const first = extractPayload(await handleToolCall(
      'orch_run_execute_agent',
      runtimeArgs,
      'full',
      {
        callTool: async () => ({
          content: [{
            type: 'text',
            text: JSON.stringify({
              requires_approval: true,
              approval_id: 'apr_nested_team',
              packet_path: 'artifacts/runs/run-team-approval__nested/approval_packet_v1.json',
            }),
          }],
          isError: false,
        }),
        createMessage: async () => ({
          model: 'claude-test',
          role: 'assistant',
          content: {
            type: 'tool_use',
            id: 'tu_nested',
            name: 'do_thing',
            input: { section: 'results' },
          },
          stopReason: 'tool_use',
        }),
      },
    )) as {
      team_state: {
        pending_approvals: Array<{
          approval_id: string;
          agent_id: string;
          assignment_id: string;
          session_id: string | null;
        }>;
        sessions: Array<{
          session_id: string;
          runtime_status: string;
          task_lifecycle_status: string;
          task_status: string;
        }>;
        delegate_assignments: Array<{
          assignment_id: string;
          status: string;
          approval_id: string | null;
          approval_packet_path: string | null;
          approval_requested_at: string | null;
        }>;
      };
    };

    expect(first.team_state.delegate_assignments[0]).toMatchObject({
      status: 'awaiting_approval',
      approval_id: 'apr_nested_team',
      approval_packet_path: 'artifacts/runs/run-team-approval__nested/approval_packet_v1.json',
    });
    expect(first.team_state.delegate_assignments[0]?.approval_requested_at).toBeTruthy();
    expect(first.team_state.pending_approvals[0]).toMatchObject({
      approval_id: 'apr_nested_team',
      agent_id: 'delegate-1',
      assignment_id: first.team_state.delegate_assignments[0]?.assignment_id,
      session_id: first.team_state.sessions[0]?.session_id ?? null,
    });
    expect(first.team_state.sessions[0]).toMatchObject({
      runtime_status: 'awaiting_approval',
      task_lifecycle_status: 'running',
      task_status: 'active',
      runtime_projection: {
        approval_requested: true,
      },
    });

    const resumedCallTool = vi.fn(async () => ({ content: [{ type: 'text', text: 'should-not-run' }], isError: false }));
    const resumed = extractPayload(await handleToolCall(
      'orch_run_execute_agent',
      {
        ...runtimeArgs,
        team: {
          ...runtimeArgs.team,
          interventions: [{ kind: 'approve', scope: 'task', actor_role: 'lead', actor_id: 'pi', task_id: 'task-team-approval' }],
        },
      },
      'full',
      {
        callTool: resumedCallTool,
        createMessage: async () => ({
          model: 'claude-test',
          role: 'assistant',
          content: { type: 'text', text: 'approved and resumed' },
          stopReason: 'endTurn',
        }),
      },
    )) as {
      resumed: boolean;
      skipped_step_ids: string[];
      team_state: {
        pending_approvals: Array<unknown>;
        sessions: Array<{ parent_session_id: string | null; task_status: string }>;
        delegate_assignments: Array<{
          assignment_id: string;
          status: string;
          approval_id: string | null;
          approval_packet_path: string | null;
          approval_requested_at: string | null;
        }>;
      };
    };

    expect(resumed.resumed).toBe(true);
    expect(resumed.skipped_step_ids).toEqual(['tu_nested']);
    expect(resumed.team_state.delegate_assignments[0]).toMatchObject({
      status: 'completed',
      approval_id: null,
      approval_packet_path: null,
      approval_requested_at: null,
    });
    expect(resumed.team_state.pending_approvals).toEqual([]);
    expect(resumed.team_state.sessions.at(-1)).toMatchObject({
      parent_session_id: first.team_state.sessions[0]?.session_id ?? null,
      task_status: 'completed',
      runtime_projection: {
        recovery_turn_count: 1,
      },
    });
    expect(resumedCallTool).not.toHaveBeenCalled();
  });
});
