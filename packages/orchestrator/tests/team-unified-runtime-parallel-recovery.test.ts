import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import {
  executeUnifiedTeamRuntime,
  type TeamPermissionMatrix,
} from '../src/index.js';

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'team-unified-runtime-parallel-recovery-'));
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

describe('team unified runtime parallel recovery', () => {
  it('keeps completed and timed-out assignments terminal while only recoverable work resumes', async () => {
    const projectRoot = makeTmpDir();
    try {
      const firstToolCall = vi.fn(async (_name: string, input: { task_id: string }) => ({
        ok: true,
        isError: false,
        rawText: `tool:${input.task_id}`,
        json: null,
        errorCode: null,
      }));
      const firstCreateMessage = vi.fn(async (params) => {
        const taskId = extractTaskId(params);
        const last = params.messages.at(-1);
        const hasToolResult = Boolean(
          last
            && last.role === 'user'
            && Array.isArray(last.content)
            && last.content.some(block => block.type === 'tool_result'),
        );
        if (taskId === 'task-parallel-complete') return textResponse('task-parallel-complete complete');
        if (taskId === 'task-parallel-recover' && !hasToolResult) {
          return toolUseResponse('tu_parallel_recover', 'do_thing', { task_id: taskId });
        }
        if (taskId === 'task-parallel-recover' && hasToolResult) {
          throw new Error('interrupt after checkpoint');
        }
        throw new Error('timed-out parallel assignment should not launch');
      });

      const first = await executeUnifiedTeamRuntime({
        projectRoot,
        runId: 'run-parallel-recovery',
        workspaceId: 'workspace:run-parallel-recovery',
        coordinationPolicy: 'parallel',
        permissions: PERMISSIONS,
        assignments: [
          { stage: 0, owner_role: 'lead', delegate_role: 'delegate', delegate_id: 'delegate-1', task_id: 'task-parallel-complete', task_kind: 'compute', handoff_id: 'handoff-parallel-complete', handoff_kind: 'compute' },
          { stage: 1, owner_role: 'lead', delegate_role: 'delegate', delegate_id: 'delegate-2', task_id: 'task-parallel-recover', task_kind: 'review', handoff_id: 'handoff-parallel-recover', handoff_kind: 'review' },
          { stage: 2, owner_role: 'lead', delegate_role: 'delegate', delegate_id: 'delegate-3', task_id: 'task-parallel-timeout', task_kind: 'compute', handoff_id: 'handoff-parallel-timeout', handoff_kind: 'compute', timeout_at: '2020-01-01T00:00:00Z' },
        ],
        messages: [{ role: 'user', content: 'go' }],
        tools: [{ name: 'do_thing', input_schema: { type: 'object', properties: {} } }],
        model: 'claude-opus-4-6',
        mcpClient: { callTool: firstToolCall },
        approvalGate: { createPending: () => ({}) } as never,
        _messagesCreate: firstCreateMessage,
      });

      expect(first.assignment_results.map(item => [item.task_id, item.status])).toEqual([
        ['task-parallel-complete', 'completed'],
        ['task-parallel-recover', 'needs_recovery'],
        ['task-parallel-timeout', 'timed_out'],
      ]);
      expect(first.live_status.active_assignments.map(item => item.task_id)).toEqual(['task-parallel-recover']);
      expect(first.live_status.terminal_assignments.map(item => item.task_id).sort()).toEqual([
        'task-parallel-complete',
        'task-parallel-timeout',
      ]);
      expect(first.live_status.terminal_assignments.find(item => item.task_id === 'task-parallel-timeout')?.timeout_at)
        .toBe('2020-01-01T00:00:00Z');
      expect(first.replay.filter(entry => entry.kind === 'assignment_timed_out')).toHaveLength(1);
      expect(firstToolCall).toHaveBeenCalledTimes(1);

      const resumedToolCall = vi.fn(async () => ({
        ok: true,
        isError: false,
        rawText: 'should-not-run',
        json: null,
        errorCode: null,
      }));
      const resumedCreateMessage = vi.fn(async (params) => textResponse(`${extractTaskId(params)} resumed`));

      const resumed = await executeUnifiedTeamRuntime({
        projectRoot,
        runId: 'run-parallel-recovery',
        workspaceId: 'workspace:run-parallel-recovery',
        coordinationPolicy: 'parallel',
        permissions: PERMISSIONS,
        assignments: [
          { stage: 0, owner_role: 'lead', delegate_role: 'delegate', delegate_id: 'delegate-1', task_id: 'task-parallel-complete', task_kind: 'compute', handoff_id: 'handoff-parallel-complete', handoff_kind: 'compute' },
          { stage: 1, owner_role: 'lead', delegate_role: 'delegate', delegate_id: 'delegate-2', task_id: 'task-parallel-recover', task_kind: 'review', handoff_id: 'handoff-parallel-recover', handoff_kind: 'review' },
          { stage: 2, owner_role: 'lead', delegate_role: 'delegate', delegate_id: 'delegate-3', task_id: 'task-parallel-timeout', task_kind: 'compute', handoff_id: 'handoff-parallel-timeout', handoff_kind: 'compute', timeout_at: '2020-01-01T00:00:00Z' },
        ],
        messages: [
          { role: 'user', content: 'resume' },
          { role: 'assistant', content: [{ type: 'tool_use', id: 'tu_parallel_recover', name: 'do_thing', input: { task_id: 'task-parallel-recover' } }] },
        ],
        tools: [{ name: 'do_thing', input_schema: { type: 'object', properties: {} } }],
        model: 'claude-opus-4-6',
        mcpClient: { callTool: resumedToolCall },
        approvalGate: { createPending: () => ({}) } as never,
        _messagesCreate: resumedCreateMessage,
      });

      expect(resumed.assignment_results.map(item => [item.task_id, item.status])).toEqual([
        ['task-parallel-complete', 'completed'],
        ['task-parallel-recover', 'completed'],
        ['task-parallel-timeout', 'timed_out'],
      ]);
      expect(resumedToolCall).not.toHaveBeenCalled();
      expect(resumedCreateMessage).toHaveBeenCalledTimes(1);
      expect(resumed.replay.filter(entry => entry.kind === 'checkpoint_restored')).toHaveLength(1);
      expect(resumed.live_status.active_assignments).toEqual([]);
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});
