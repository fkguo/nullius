import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import {
  executeTeamDelegatedRuntime,
  executeUnifiedTeamRuntime,
  type TeamPermissionMatrix,
} from '../src/index.js';

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'team-unified-runtime-'));
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
