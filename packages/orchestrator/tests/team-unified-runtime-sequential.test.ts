import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import {
  executeUnifiedTeamRuntime,
  type TeamPermissionMatrix,
} from '../src/index.js';
import { teamExecutionStatePath } from '../src/team-execution-storage.js';

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'team-unified-runtime-sequential-'));
}

function textResponse(text: string) {
  return { content: [{ type: 'text' as const, text }], stop_reason: 'end_turn' };
}

function toolUseResponse(id: string, taskId: string) {
  return { content: [{ type: 'tool_use' as const, id, name: 'do_thing', input: { task_id: taskId } }], stop_reason: 'tool_use' };
}

function hasToolResult(messages: Array<{ role: string; content: unknown }>): boolean {
  const last = messages.at(-1);
  return Boolean(last && last.role === 'user' && Array.isArray(last.content) && last.content.some(block => block.type === 'tool_result'));
}

function taskIdFromMessages(messages: Array<{ role: string; content: unknown }>, taskIds: string[]): string {
  const protocol = messages
    .filter(message => message.role === 'user' && typeof message.content === 'string')
    .map(message => message.content)
    .find(content => content.includes('## TASK'));
  const taskId = taskIds.find(candidate => protocol?.includes(candidate));
  if (!taskId) throw new Error('missing sequential delegation protocol');
  return taskId;
}

const PERMISSIONS: TeamPermissionMatrix = {
  delegation: [{ from_role: 'lead', to_role: 'delegate', allowed_task_kinds: ['compute', 'review'], allowed_handoff_kinds: ['compute', 'review'] }],
  interventions: [
    { actor_role: 'lead', allowed_scopes: ['task', 'team'], allowed_kinds: ['pause', 'resume', 'cancel', 'cascade_stop'] },
    { actor_role: 'lead', allowed_scopes: ['task'], allowed_kinds: ['approve', 'redirect', 'inject_task'] },
  ],
};

describe('team unified runtime sequential policy', () => {
  it('runs sequential assignments one at a time and saves merged state before launching the next assignment', async () => {
    const projectRoot = makeTmpDir();
    try {
      const taskIds = ['task-sequential-1', 'task-sequential-2'];
      let releaseBarrier: (() => void) | null = null;
      const barrier = new Promise<void>(resolve => { releaseBarrier = resolve; });
      let firstLaunchReady: (() => void) | null = null;
      const firstLaunch = new Promise<void>(resolve => { firstLaunchReady = resolve; });
      const callOrder: string[] = [];
      const createMessage = vi.fn(async params => {
        const taskId = taskIdFromMessages(params.messages, taskIds);
        return hasToolResult(params.messages) ? textResponse(`${taskId} complete`) : toolUseResponse(`tu_${taskId}`, taskId);
      });
      const callTool = vi.fn(async (_name: string, input: { task_id: string }) => {
        callOrder.push(input.task_id);
        if (input.task_id === 'task-sequential-1') {
          firstLaunchReady?.();
          await barrier;
        }
        if (input.task_id === 'task-sequential-2') {
          const persisted = JSON.parse(fs.readFileSync(teamExecutionStatePath(projectRoot, 'run-sequential-order'), 'utf-8')) as {
            delegate_assignments: Array<{ task_id: string; status: string }>;
          };
          expect(persisted.delegate_assignments.find(item => item.task_id === 'task-sequential-1')?.status).toBe('completed');
          expect(persisted.delegate_assignments.find(item => item.task_id === 'task-sequential-2')?.status).toBe('running');
        }
        return { ok: true, isError: false, rawText: `tool:${input.task_id}`, json: null, errorCode: null };
      });

      const runtimePromise = executeUnifiedTeamRuntime({
        projectRoot,
        runId: 'run-sequential-order',
        workspaceId: 'workspace:run-sequential-order',
        coordinationPolicy: 'sequential',
        permissions: PERMISSIONS,
        assignments: [
          { stage: 0, owner_role: 'lead', delegate_role: 'delegate', delegate_id: 'delegate-1', task_id: taskIds[0], task_kind: 'compute' },
          { stage: 1, owner_role: 'lead', delegate_role: 'delegate', delegate_id: 'delegate-2', task_id: taskIds[1], task_kind: 'review' },
        ],
        messages: [{ role: 'user', content: 'go' }],
        tools: [{ name: 'do_thing', input_schema: { type: 'object', properties: {} } }],
        model: 'claude-opus-4-6',
        mcpClient: { callTool },
        approvalGate: { createPending: () => ({}) } as never,
        _messagesCreate: createMessage,
      });

      await Promise.race([firstLaunch, new Promise<void>((_, reject) => setTimeout(() => reject(new Error('first launch not observed')), 50))]);
      expect(callOrder).toEqual(['task-sequential-1']);
      releaseBarrier?.();

      const result = await runtimePromise;
      expect(callOrder).toEqual(taskIds);
      expect(result.assignment_results.map(item => [item.task_id, item.status])).toEqual([
        ['task-sequential-1', 'completed'],
        ['task-sequential-2', 'completed'],
      ]);
      expect(result.replay.some(entry => entry.kind === 'stage_started' || entry.kind === 'stage_blocked')).toBe(false);
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it('keeps sequential failure semantics team-local without faking stage_blocked', async () => {
    const projectRoot = makeTmpDir();
    try {
      const taskIds = ['task-sequential-ok-1', 'task-sequential-fail-2', 'task-sequential-ok-3'];
      const result = await executeUnifiedTeamRuntime({
        projectRoot,
        runId: 'run-sequential-failure',
        workspaceId: 'workspace:run-sequential-failure',
        coordinationPolicy: 'sequential',
        permissions: PERMISSIONS,
        assignments: taskIds.map((taskId, index) => ({
          stage: index,
          owner_role: 'lead',
          delegate_role: 'delegate',
          delegate_id: `delegate-${index + 1}`,
          task_id: taskId,
          task_kind: index === 1 ? 'review' : 'compute',
        })),
        messages: [{ role: 'user', content: 'go' }],
        tools: [],
        model: 'claude-opus-4-6',
        mcpClient: { callTool: vi.fn(async () => ({ ok: true, isError: false, rawText: 'unused', json: null, errorCode: null })) },
        approvalGate: { createPending: () => ({}) } as never,
        _messagesCreate: vi.fn(async params => {
          const taskId = taskIdFromMessages(params.messages, taskIds);
          if (taskId === 'task-sequential-fail-2') throw new Error('sequential delegate failed');
          return textResponse(`${taskId} complete`);
        }),
      });

      expect(result.assignment_results.map(item => [item.task_id, item.status])).toEqual([
        ['task-sequential-ok-1', 'completed'],
        ['task-sequential-fail-2', 'failed'],
        ['task-sequential-ok-3', 'completed'],
      ]);
      expect(result.blocked_stage).toBeNull();
      expect(result.replay.some(entry => entry.kind === 'stage_started' || entry.kind === 'stage_blocked')).toBe(false);
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it('keeps supervised_delegate as a single-assignment bridge mode', async () => {
    const projectRoot = makeTmpDir();
    try {
      await expect(executeUnifiedTeamRuntime({
        projectRoot,
        runId: 'run-supervised-delegate-multi',
        workspaceId: 'workspace:run-supervised-delegate-multi',
        coordinationPolicy: 'supervised_delegate',
        permissions: PERMISSIONS,
        assignments: [
          { stage: 0, owner_role: 'lead', delegate_role: 'delegate', delegate_id: 'delegate-1', task_id: 'task-supervised-1', task_kind: 'compute' },
          { stage: 1, owner_role: 'lead', delegate_role: 'delegate', delegate_id: 'delegate-2', task_id: 'task-supervised-2', task_kind: 'review' },
        ],
        messages: [{ role: 'user', content: 'go' }],
        tools: [],
        model: 'claude-opus-4-6',
        mcpClient: { callTool: vi.fn(async () => ({ ok: true, isError: false, rawText: 'unused', json: null, errorCode: null })) },
        approvalGate: { createPending: () => ({}) } as never,
        _messagesCreate: vi.fn().mockResolvedValue(textResponse('done')),
      })).rejects.toThrow(/supervised_delegate only supports a single assignment/i);
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});
