import { describe, expect, it, vi } from 'vitest';

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
          task_id: string;
          task_kind: string;
          handoff_id: string | null;
          handoff_kind: string | null;
        }>;
        checkpoints: Array<{ checkpoint_id: string; task_id: string; handoff_id: string | null }>;
      };
    };
    expect(first.last_completed_step).toBe('tu_write');
    expect(first.team_state.workspace_id).toBe('workspace:run-team');
    expect(first.team_state.delegate_assignments[0]).toMatchObject({
      task_id: 'task-draft-update',
      task_kind: 'draft_update',
      handoff_id: 'handoff-writing-1',
      handoff_kind: 'writing',
    });
    expect(first.team_state.checkpoints[0]).toMatchObject({
      task_id: 'task-draft-update',
      handoff_id: 'handoff-writing-1',
    });

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
});
