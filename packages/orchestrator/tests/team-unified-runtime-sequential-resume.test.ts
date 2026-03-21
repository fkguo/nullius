import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import {
  executeUnifiedTeamRuntime,
  type TeamPermissionMatrix,
} from '../src/index.js';

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'team-unified-runtime-sequential-resume-'));
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

describe('team unified runtime sequential resume', () => {
  it('keeps completed assignments terminal while resuming only recoverable sequential work', async () => {
    const projectRoot = makeTmpDir();
    try {
      const taskIds = ['task-sequential-complete-1', 'task-sequential-recover-2', 'task-sequential-complete-3'];
      const first = await executeUnifiedTeamRuntime({
        projectRoot,
        runId: 'run-sequential-resume',
        workspaceId: 'workspace:run-sequential-resume',
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
        tools: [{ name: 'do_thing', input_schema: { type: 'object', properties: {} } }],
        model: 'claude-opus-4-6',
        mcpClient: { callTool: vi.fn(async () => ({ ok: true, isError: false, rawText: 'tool-result', json: null, errorCode: null })) },
        approvalGate: { createPending: () => ({}) } as never,
        _messagesCreate: vi.fn(async params => {
          const taskId = taskIdFromMessages(params.messages, taskIds);
          if (taskId === 'task-sequential-complete-1' || taskId === 'task-sequential-complete-3') {
            return textResponse(`${taskId} complete`);
          }
          return hasToolResult(params.messages)
            ? Promise.reject(new Error('interrupt after checkpoint'))
            : toolUseResponse('tu_sequential_recover', taskId);
        }),
      });

      expect(first.assignment_results.map(item => [item.task_id, item.status])).toEqual([
        ['task-sequential-complete-1', 'completed'],
        ['task-sequential-recover-2', 'needs_recovery'],
        ['task-sequential-complete-3', 'completed'],
      ]);
      expect(first.live_status.active_assignments.map(item => item.task_id)).toEqual(['task-sequential-recover-2']);
      expect(first.replay.some(entry => entry.kind === 'stage_blocked')).toBe(false);

      const resumedCallTool = vi.fn(async () => ({ ok: true, isError: false, rawText: 'should-not-run', json: null, errorCode: null }));
      const resumedCreateMessage = vi.fn(async params => {
        const taskId = taskIdFromMessages(params.messages, taskIds);
        return textResponse(`${taskId} resumed`);
      });

      const resumed = await executeUnifiedTeamRuntime({
        projectRoot,
        runId: 'run-sequential-resume',
        workspaceId: 'workspace:run-sequential-resume',
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
        messages: [
          { role: 'user', content: 'resume' },
          { role: 'assistant', content: [{ type: 'tool_use', id: 'tu_sequential_recover', name: 'do_thing', input: { task_id: 'task-sequential-recover-2' } }] },
        ],
        tools: [{ name: 'do_thing', input_schema: { type: 'object', properties: {} } }],
        model: 'claude-opus-4-6',
        mcpClient: { callTool: resumedCallTool },
        approvalGate: { createPending: () => ({}) } as never,
        _messagesCreate: resumedCreateMessage,
      });

      expect(resumed.assignment_results.map(item => [item.task_id, item.status])).toEqual([
        ['task-sequential-complete-1', 'completed'],
        ['task-sequential-recover-2', 'completed'],
        ['task-sequential-complete-3', 'completed'],
      ]);
      expect(resumedCreateMessage).toHaveBeenCalledTimes(1);
      expect(resumedCallTool).not.toHaveBeenCalled();
      expect(resumed.replay.filter(entry => entry.kind === 'checkpoint_restored')).toHaveLength(1);
      expect(resumed.live_status.active_assignments).toEqual([]);
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});
