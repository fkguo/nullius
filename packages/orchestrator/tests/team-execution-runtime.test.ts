import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { executeTeamDelegatedRuntime, type MessageParam, type Tool, type TeamPermissionMatrix } from '../src/index.js';

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'team-delegated-runtime-'));
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
      allowed_scopes: ['task', 'team', 'project'],
      allowed_kinds: ['pause', 'resume', 'cancel', 'cascade_stop'],
    },
  ],
};

const TOOLS: Tool[] = [{ name: 'do_thing', input_schema: { type: 'object', properties: {} } }];

function toolUseResponse(id: string, name: string, input: Record<string, unknown> = {}) {
  return {
    content: [{ type: 'tool_use' as const, id, name, input }],
    stop_reason: 'tool_use',
  };
}

function textResponse(text: string) {
  return {
    content: [{ type: 'text' as const, text }],
    stop_reason: 'end_turn',
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('executeTeamDelegatedRuntime', () => {
  it('persists team-local checkpoint state and resumes through the delegated runtime seam', async () => {
    const projectRoot = makeTmpDir();
    try {
      const messages: MessageParam[] = [{ role: 'user', content: 'go' }];
      const first = await executeTeamDelegatedRuntime({
        projectRoot,
        runId: 'run-team',
        workspaceId: 'ws-team',
        taskId: 'task-team',
        taskKind: 'compute',
        ownerRole: 'lead',
        delegateRole: 'delegate',
        delegateId: 'delegate-1',
        coordinationPolicy: 'supervised_delegate',
        permissions: PERMISSIONS,
        messages,
        tools: TOOLS,
        model: 'claude-opus-4-6',
        mcpClient: {
          callTool: vi.fn(async () => ({ ok: true, isError: false, rawText: 'tool-result', json: null, errorCode: null })),
        },
        approvalGate: { createPending: () => ({}) } as never,
        _messagesCreate: vi.fn()
          .mockResolvedValueOnce(toolUseResponse('tu_team', 'do_thing'))
          .mockResolvedValueOnce(textResponse('done')),
      });

      expect(first.last_completed_step).toBe('tu_team');
      expect(first.team_state.delegate_assignments[0]?.last_completed_step).toBe('tu_team');
      expect(fs.existsSync(first.team_state_path)).toBe(true);

      const resumedClient = {
        callTool: vi.fn(async () => ({ ok: true, isError: false, rawText: 'should-not-run', json: null, errorCode: null })),
      };
      const resumed = await executeTeamDelegatedRuntime({
        projectRoot,
        runId: 'run-team',
        workspaceId: 'ws-team',
        taskId: 'task-team',
        taskKind: 'compute',
        ownerRole: 'lead',
        delegateRole: 'delegate',
        delegateId: 'delegate-1',
        coordinationPolicy: 'supervised_delegate',
        permissions: PERMISSIONS,
        messages: [
          { role: 'user', content: 'resume' },
          { role: 'assistant', content: [{ type: 'tool_use', id: 'tu_team', name: 'do_thing', input: {} }] },
        ],
        tools: TOOLS,
        model: 'claude-opus-4-6',
        mcpClient: resumedClient,
        approvalGate: { createPending: () => ({}) } as never,
        _messagesCreate: vi.fn().mockResolvedValueOnce(textResponse('resumed')),
      });

      expect(resumed.resumed).toBe(true);
      expect(resumed.skipped_step_ids).toEqual(['tu_team']);
      expect(resumed.team_state.delegate_assignments[0]?.resume_from).toBe('tu_team');
      expect(resumedClient.callTool).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it('fails closed when the delegation permission matrix does not allow the requested task', async () => {
    const projectRoot = makeTmpDir();
    try {
      await expect(executeTeamDelegatedRuntime({
        projectRoot,
        runId: 'run-deny',
        workspaceId: 'ws-deny',
        taskId: 'task-deny',
        taskKind: 'review',
        ownerRole: 'lead',
        delegateRole: 'delegate',
        delegateId: 'delegate-1',
        coordinationPolicy: 'supervised_delegate',
        permissions: {
          ...PERMISSIONS,
          delegation: [{ ...PERMISSIONS.delegation[0]!, allowed_task_kinds: ['compute'] }],
        },
        messages: [{ role: 'user', content: 'go' }],
        tools: TOOLS,
        model: 'claude-opus-4-6',
        mcpClient: { callTool: vi.fn(async () => ({ ok: true, isError: false, rawText: 'x', json: null, errorCode: null })) },
        approvalGate: { createPending: () => ({}) } as never,
        _messagesCreate: vi.fn().mockResolvedValue(textResponse('done')),
      })).rejects.toThrow(/delegation denied/i);
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });

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
        tools: TOOLS,
        model: 'claude-opus-4-6',
        maxTurns: 1,
        mcpClient: {
          callTool: vi.fn(async () => ({ ok: true, isError: false, rawText: 'tool-result', json: null, errorCode: null })),
        },
        approvalGate: { createPending: () => ({}) } as never,
        _messagesCreate: vi.fn().mockResolvedValue(toolUseResponse('tu_loop', 'do_thing')),
      });

      expect(result.events.at(-1)).toMatchObject({ type: 'done', stopReason: 'max_turns' });
      expect(result.team_state.delegate_assignments[0]?.status).toBe('running');
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
        tools: TOOLS,
        model: 'claude-opus-4-6',
        interventions: [{
          kind: 'pause',
          scope: 'task',
          actor_role: 'lead',
          actor_id: 'pi',
          task_id: 'task-pause',
        }],
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
        tools: TOOLS,
        model: 'claude-opus-4-6',
        interventions: [{
          kind: 'cascade_stop',
          scope: 'team',
          actor_role: 'lead',
          actor_id: 'pi',
          note: 'stop all delegates',
        }],
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
});
