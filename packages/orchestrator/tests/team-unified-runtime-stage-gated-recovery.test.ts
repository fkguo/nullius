import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import {
  executeUnifiedTeamRuntime,
  type TeamPermissionMatrix,
} from '../src/index.js';

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'team-unified-runtime-stage-gated-recovery-'));
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

function extractTaskId(params: { messages: Array<{ role: string; content: unknown }> }): string {
  const protocol = params.messages
    .filter(message => message.role === 'user' && typeof message.content === 'string')
    .map(message => message.content)
    .find(content => content.includes('## TASK'));
  const match = protocol?.match(/task_id:\s*([^\n]+)/);
  if (!match?.[1]) throw new Error('missing task protocol');
  return match[1].trim();
}

const PERMISSIONS: TeamPermissionMatrix = {
  delegation: [{
    from_role: 'lead',
    to_role: 'delegate',
    allowed_task_kinds: ['compute', 'review'],
    allowed_handoff_kinds: ['compute', 'review'],
  }],
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

describe('team unified runtime stage-gated recovery', () => {
  it('keeps blocked_stage persisted until the blocked stage actually recovers and only then advances', async () => {
    const projectRoot = makeTmpDir();
    try {
      const first = await executeUnifiedTeamRuntime({
        projectRoot,
        runId: 'run-stage-gated-recovery',
        workspaceId: 'workspace:run-stage-gated-recovery',
        coordinationPolicy: 'stage_gated',
        permissions: PERMISSIONS,
        assignments: [
          { stage: 0, owner_role: 'lead', delegate_role: 'delegate', delegate_id: 'delegate-1', task_id: 'task-stage-complete', task_kind: 'compute', handoff_id: 'handoff-stage-complete', handoff_kind: 'compute' },
          { stage: 1, owner_role: 'lead', delegate_role: 'delegate', delegate_id: 'delegate-2', task_id: 'task-stage-recover', task_kind: 'review', handoff_id: 'handoff-stage-recover', handoff_kind: 'review' },
          { stage: 2, owner_role: 'lead', delegate_role: 'delegate', delegate_id: 'delegate-3', task_id: 'task-stage-later', task_kind: 'compute', handoff_id: 'handoff-stage-later', handoff_kind: 'compute' },
        ],
        messages: [{ role: 'user', content: 'go' }],
        tools: [{ name: 'do_thing', input_schema: { type: 'object', properties: {} } }],
        model: 'claude-opus-4-6',
        mcpClient: {
          callTool: vi.fn(async () => ({ ok: true, isError: false, rawText: 'tool-result', json: null, errorCode: null })),
        },
        approvalGate: { createPending: () => ({}) } as never,
        _messagesCreate: vi.fn(async (params) => {
          const taskId = extractTaskId(params);
          const last = params.messages.at(-1);
          const hasToolResult = Boolean(
            last
              && last.role === 'user'
              && Array.isArray(last.content)
              && last.content.some(block => block.type === 'tool_result'),
          );
          if (taskId === 'task-stage-complete') return textResponse('task-stage-complete complete');
          if (taskId === 'task-stage-recover' && !hasToolResult) {
            return toolUseResponse('tu_stage_recover', 'do_thing', { task_id: taskId });
          }
          if (taskId === 'task-stage-recover' && hasToolResult) {
            throw new Error('interrupt after checkpoint');
          }
          throw new Error('later stages should stay blocked');
        }),
      });

      expect(first.assignment_results.map(item => [item.task_id, item.status])).toEqual([
        ['task-stage-complete', 'completed'],
        ['task-stage-recover', 'needs_recovery'],
      ]);
      expect(first.blocked_stage).toBe(1);
      expect(first.replay.some(entry => entry.kind === 'stage_blocked' && entry.payload.stage === 1)).toBe(true);

      let releaseBarrier: (() => void) | null = null;
      let readyResolve: (() => void) | null = null;
      const barrier = new Promise<void>(resolve => { releaseBarrier = resolve; });
      const ready = new Promise<void>(resolve => { readyResolve = resolve; });
      const resumedTasks: string[] = [];
      const resumedToolCall = vi.fn(async () => ({
        ok: true,
        isError: false,
        rawText: 'should-not-run',
        json: null,
        errorCode: null,
      }));

      const resumedPromise = executeUnifiedTeamRuntime({
        projectRoot,
        runId: 'run-stage-gated-recovery',
        workspaceId: 'workspace:run-stage-gated-recovery',
        coordinationPolicy: 'stage_gated',
        permissions: PERMISSIONS,
        assignments: [
          { stage: 0, owner_role: 'lead', delegate_role: 'delegate', delegate_id: 'delegate-1', task_id: 'task-stage-complete', task_kind: 'compute', handoff_id: 'handoff-stage-complete', handoff_kind: 'compute' },
          { stage: 1, owner_role: 'lead', delegate_role: 'delegate', delegate_id: 'delegate-2', task_id: 'task-stage-recover', task_kind: 'review', handoff_id: 'handoff-stage-recover', handoff_kind: 'review' },
          { stage: 2, owner_role: 'lead', delegate_role: 'delegate', delegate_id: 'delegate-3', task_id: 'task-stage-later', task_kind: 'compute', handoff_id: 'handoff-stage-later', handoff_kind: 'compute' },
        ],
        messages: [
          { role: 'user', content: 'resume' },
          { role: 'assistant', content: [{ type: 'tool_use', id: 'tu_stage_recover', name: 'do_thing', input: { task_id: 'task-stage-recover' } }] },
        ],
        tools: [{ name: 'do_thing', input_schema: { type: 'object', properties: {} } }],
        model: 'claude-opus-4-6',
        mcpClient: { callTool: resumedToolCall },
        approvalGate: { createPending: () => ({}) } as never,
        _messagesCreate: vi.fn(async (params) => {
          const taskId = extractTaskId(params);
          resumedTasks.push(taskId);
          if (taskId === 'task-stage-complete') {
            throw new Error('completed earlier stages should not relaunch');
          }
          if (taskId === 'task-stage-recover') {
            readyResolve?.();
            await barrier;
            return textResponse('task-stage-recover resumed');
          }
          return textResponse('task-stage-later complete');
        }),
      });

      await Promise.race([
        ready,
        new Promise<void>((_, reject) => setTimeout(() => reject(new Error('stage recovery did not start')), 100)),
      ]);
      const persisted = JSON.parse(fs.readFileSync(first.team_state_path, 'utf-8')) as { blocked_stage: number | null };
      expect(persisted.blocked_stage).toBe(1);
      releaseBarrier?.();

      const resumed = await resumedPromise;
      expect(resumedTasks).toEqual(['task-stage-recover', 'task-stage-later']);
      expect(resumedToolCall).not.toHaveBeenCalled();
      expect(resumed.blocked_stage).toBeNull();
      expect(resumed.assignment_results.map(item => [item.task_id, item.status])).toEqual([
        ['task-stage-complete', 'completed'],
        ['task-stage-recover', 'completed'],
        ['task-stage-later', 'completed'],
      ]);
      expect(resumed.replay.filter(entry => entry.kind === 'checkpoint_restored')).toHaveLength(1);
      expect(resumed.replay.filter(entry => entry.kind === 'stage_blocked' && entry.payload.stage === 1)).toHaveLength(1);
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});
