import { describe, expect, it, vi } from 'vitest';

import { handleToolCall } from '../../src/tools/index.js';
import { extractPayload, makeTmpDir } from './orchRunExecuteAgentTestSupport.js';

function textBlock(message: { content: unknown }): string {
  const blocks = Array.isArray(message.content) ? message.content : [message.content];
  return blocks
    .filter((block): block is { type: 'text'; text: string } => Boolean(block && typeof block === 'object' && 'type' in block && block.type === 'text'))
    .map(block => block.text)
    .join('\n');
}

function taskIdFromMessages(messages: Array<{ role: string; content: unknown }>, taskIds: string[]): string {
  const protocol = messages.filter(message => message.role === 'user').map(textBlock).find(content => content.includes('## TASK'));
  const taskId = taskIds.find(candidate => protocol?.includes(candidate));
  if (!taskId) throw new Error('missing parallel recovery task protocol');
  return taskId;
}

function hasToolResult(messages: Array<{ role: string; content: unknown }>): boolean {
  const last = messages.at(-1);
  const blocks = last ? (Array.isArray(last.content) ? last.content : [last.content]) : [];
  return blocks.some(block => Boolean(block && typeof block === 'object' && 'type' in block && block.type === 'tool_result'));
}

describe('orch_run_execute_agent parallel recovery bridge', () => {
  it('keeps completed and timed-out assignments terminal while only recoverable host-path work resumes', async () => {
    const projectRoot = makeTmpDir();
    await handleToolCall(
      'orch_run_create',
      { project_root: projectRoot, run_id: 'run-team-parallel-recovery', workflow_id: 'runtime' },
      'full',
    );

    const taskIds = ['task-host-parallel-complete', 'task-host-parallel-recover', 'task-host-parallel-timeout'];
    const firstToolCall = vi.fn(async (_name: string, input: { task_id: string }) => ({
      content: [{ type: 'text', text: `tool:${input.task_id}` }],
      isError: false,
    }));
    const first = extractPayload(await handleToolCall(
      'orch_run_execute_agent',
      {
        _confirm: true,
        project_root: projectRoot,
        run_id: 'run-team-parallel-recovery',
        model: 'claude-test',
        messages: [{ role: 'user', content: 'coordinate the team' }],
        tools: [{ name: 'do_thing', input_schema: { type: 'object', properties: {} } }],
        team: {
          workspace_id: 'workspace:run-team-parallel-recovery',
          owner_role: 'lead',
          coordination_policy: 'parallel',
          assignments: [
            { stage: 0, task_id: taskIds[0], task_kind: 'compute', delegate_role: 'delegate', delegate_id: 'delegate-1', handoff_id: 'handoff-1', handoff_kind: 'compute' },
            { stage: 1, task_id: taskIds[1], task_kind: 'review', delegate_role: 'delegate', delegate_id: 'delegate-2', handoff_id: 'handoff-2', handoff_kind: 'review' },
            { stage: 2, task_id: taskIds[2], task_kind: 'compute', delegate_role: 'delegate', delegate_id: 'delegate-3', handoff_id: 'handoff-3', handoff_kind: 'compute', timeout_at: '2020-01-01T00:00:00Z' },
          ],
        },
      },
      'full',
      {
        callTool: firstToolCall,
        createMessage: async params => {
          const taskId = taskIdFromMessages(params.messages, taskIds);
          if (taskId === taskIds[0]) {
            return { model: 'claude-test', role: 'assistant', content: { type: 'text', text: `${taskId} complete` }, stopReason: 'endTurn' };
          }
          if (taskId === taskIds[1] && !hasToolResult(params.messages)) {
            return { model: 'claude-test', role: 'assistant', content: { type: 'tool_use', id: 'tu_host_parallel_recover', name: 'do_thing', input: { task_id: taskId } }, stopReason: 'tool_use' };
          }
          if (taskId === taskIds[1] && hasToolResult(params.messages)) {
            throw new Error('interrupt after checkpoint');
          }
          throw new Error('timed-out host-path assignment should not launch');
        },
      },
    )) as {
      assignment_results: Array<{ task_id: string; status: string }>;
      live_status: { active_assignments: Array<{ task_id: string }>; terminal_assignments: Array<{ task_id: string; timeout_at: string | null }> };
      replay: Array<{ kind: string }>;
    };

    expect(first.assignment_results.map(item => [item.task_id, item.status])).toEqual([
      [taskIds[0], 'completed'],
      [taskIds[1], 'needs_recovery'],
      [taskIds[2], 'timed_out'],
    ]);
    expect(first.live_status.active_assignments.map(item => item.task_id)).toEqual([taskIds[1]]);
    expect(first.live_status.terminal_assignments.find(item => item.task_id === taskIds[2])?.timeout_at).toBe('2020-01-01T00:00:00Z');
    expect(first.replay.some(entry => entry.kind === 'assignment_timed_out')).toBe(true);
    expect(firstToolCall).toHaveBeenCalledTimes(1);

    const resumedCallTool = vi.fn(async () => ({ content: [{ type: 'text', text: 'should-not-run' }], isError: false }));
    const resumed = extractPayload(await handleToolCall(
      'orch_run_execute_agent',
      {
        _confirm: true,
        project_root: projectRoot,
        run_id: 'run-team-parallel-recovery',
        model: 'claude-test',
        messages: [
          { role: 'user', content: 'resume the team' },
          { role: 'assistant', content: [{ type: 'tool_use', id: 'tu_host_parallel_recover', name: 'do_thing', input: { task_id: taskIds[1] } }] },
        ],
        tools: [{ name: 'do_thing', input_schema: { type: 'object', properties: {} } }],
        team: {
          workspace_id: 'workspace:run-team-parallel-recovery',
          owner_role: 'lead',
          coordination_policy: 'parallel',
          assignments: [
            { stage: 0, task_id: taskIds[0], task_kind: 'compute', delegate_role: 'delegate', delegate_id: 'delegate-1', handoff_id: 'handoff-1', handoff_kind: 'compute' },
            { stage: 1, task_id: taskIds[1], task_kind: 'review', delegate_role: 'delegate', delegate_id: 'delegate-2', handoff_id: 'handoff-2', handoff_kind: 'review' },
            { stage: 2, task_id: taskIds[2], task_kind: 'compute', delegate_role: 'delegate', delegate_id: 'delegate-3', handoff_id: 'handoff-3', handoff_kind: 'compute', timeout_at: '2020-01-01T00:00:00Z' },
          ],
        },
      },
      'full',
      {
        callTool: resumedCallTool,
        createMessage: async params => ({
          model: 'claude-test',
          role: 'assistant',
          content: { type: 'text', text: `${taskIdFromMessages(params.messages, taskIds)} resumed` },
          stopReason: 'endTurn',
        }),
      },
    )) as {
      assignment_results: Array<{ task_id: string; status: string }>;
      live_status: { active_assignments: Array<unknown> };
      replay: Array<{ kind: string }>;
    };

    expect(resumed.assignment_results.map(item => [item.task_id, item.status])).toEqual([
      [taskIds[0], 'completed'],
      [taskIds[1], 'completed'],
      [taskIds[2], 'timed_out'],
    ]);
    expect(resumedCallTool).not.toHaveBeenCalled();
    expect(resumed.replay.filter(entry => entry.kind === 'checkpoint_restored')).toHaveLength(1);
    expect(resumed.live_status.active_assignments).toEqual([]);
  });
});
