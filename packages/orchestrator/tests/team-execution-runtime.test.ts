import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ORCH_RUN_LIST, ORCH_RUN_STATUS } from '@autoresearch/shared';

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
      allowed_scopes: ['task', 'team'],
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

function multiToolUseResponse(blocks: Array<{ id: string; name: string; input?: Record<string, unknown> }>) {
  return {
    content: blocks.map(block => ({
      type: 'tool_use' as const,
      id: block.id,
      name: block.name,
      input: block.input ?? {},
    })),
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
  it('persists team-local checkpoint state and keeps completed work terminal on re-entry', async () => {
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

      expect(resumed.resumed).toBe(false);
      expect(resumed.skipped_step_ids).toEqual([]);
      expect(resumed.team_state.delegate_assignments[0]?.resume_from).toBeNull();
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

  it('filters delegated tool visibility and fail-closes blocked tool calls at runtime', async () => {
    const projectRoot = makeTmpDir();
    try {
      const createMessage = vi.fn(async params => {
        expect(params.tools.map(tool => tool.name)).toEqual(['allowed_tool']);
        return toolUseResponse('tu_blocked', 'blocked_tool');
      });
      const callTool = vi.fn(async () => ({ ok: true, isError: false, rawText: 'should-not-run', json: null, errorCode: null }));

      const result = await executeTeamDelegatedRuntime({
        projectRoot,
        runId: 'run-tool-filter',
        workspaceId: 'ws-tool-filter',
        taskId: 'task-tool-filter',
        taskKind: 'compute',
        ownerRole: 'lead',
        delegateRole: 'delegate',
        delegateId: 'delegate-1',
        coordinationPolicy: 'supervised_delegate',
        permissions: {
          delegation: [
            {
              ...PERMISSIONS.delegation[0]!,
              allowed_tool_names: ['allowed_tool'],
            },
          ],
          interventions: PERMISSIONS.interventions,
        },
        messages: [{ role: 'user', content: 'go' }],
        tools: [
          { name: 'allowed_tool', input_schema: { type: 'object', properties: {} } },
          { name: 'blocked_tool', input_schema: { type: 'object', properties: {} } },
        ],
        model: 'claude-opus-4-6',
        mcpClient: { callTool },
        approvalGate: { createPending: () => ({}) } as never,
        _messagesCreate: createMessage,
      });

      expect(callTool).not.toHaveBeenCalled();
      expect(result.events).toMatchObject([
        {
          type: 'error',
          error: {
            code: 'INVALID_PARAMS',
            message: expect.stringContaining('blocked_tool'),
          },
        },
      ]);
      expect(result.team_state.delegate_assignments[0]?.status).toBe('failed');
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it('keeps blocked known read-only tools out of batch-safe groups in the delegated runtime path', async () => {
    const projectRoot = makeTmpDir();
    try {
      const createMessage = vi.fn(async params => {
        expect(params.tools.map(tool => tool.name)).toEqual([ORCH_RUN_LIST]);
        return multiToolUseResponse([
          { id: 'tu_blocked_status', name: ORCH_RUN_STATUS },
          { id: 'tu_allowed_list', name: ORCH_RUN_LIST },
        ]);
      });
      const callTool = vi.fn(async () => ({ ok: true, isError: false, rawText: 'should-not-run', json: null, errorCode: null }));

      const result = await executeTeamDelegatedRuntime({
        projectRoot,
        runId: 'run-known-tool-filter',
        workspaceId: 'ws-known-tool-filter',
        taskId: 'task-known-tool-filter',
        taskKind: 'compute',
        ownerRole: 'lead',
        delegateRole: 'delegate',
        delegateId: 'delegate-1',
        coordinationPolicy: 'supervised_delegate',
        permissions: {
          delegation: [
            {
              ...PERMISSIONS.delegation[0]!,
              allowed_tool_names: [ORCH_RUN_LIST],
            },
          ],
          interventions: PERMISSIONS.interventions,
        },
        messages: [{ role: 'user', content: 'go' }],
        tools: [
          { name: ORCH_RUN_STATUS, input_schema: { type: 'object', properties: {} } },
          { name: ORCH_RUN_LIST, input_schema: { type: 'object', properties: {} } },
        ],
        model: 'claude-opus-4-6',
        mcpClient: { callTool },
        approvalGate: { createPending: () => ({}) } as never,
        _messagesCreate: createMessage,
      });

      expect(callTool).not.toHaveBeenCalled();
      expect(result.events).toMatchObject([
        {
          type: 'error',
          error: {
            code: 'INVALID_PARAMS',
            message: expect.stringContaining(ORCH_RUN_STATUS),
          },
        },
      ]);
      expect(result.team_state.delegate_assignments[0]?.status).toBe('failed');
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});
