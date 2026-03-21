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
  if (!taskId) throw new Error('missing sequential task protocol');
  return taskId;
}

function hasToolResult(messages: Array<{ role: string; content: unknown }>): boolean {
  const last = messages.at(-1);
  const blocks = last ? (Array.isArray(last.content) ? last.content : [last.content]) : [];
  return blocks.some(block => Boolean(block && typeof block === 'object' && 'type' in block && block.type === 'tool_result'));
}

describe('orch_run_execute_agent sequential team bridge', () => {
  it('proves sequential multi-assignment order and live view through the shared host path', async () => {
    const projectRoot = makeTmpDir();
    await handleToolCall('orch_run_create', { project_root: projectRoot, run_id: 'run-team-sequential', workflow_id: 'runtime' }, 'full');

    const taskIds = ['task-host-sequential-1', 'task-host-sequential-2'];
    let releaseBarrier: (() => void) | null = null;
    const barrier = new Promise<void>(resolve => { releaseBarrier = resolve; });
    let firstLaunchReady: (() => void) | null = null;
    const firstLaunch = new Promise<void>(resolve => { firstLaunchReady = resolve; });
    const callOrder: string[] = [];

    const resultPromise = handleToolCall(
      'orch_run_execute_agent',
      {
        _confirm: true,
        project_root: projectRoot,
        run_id: 'run-team-sequential',
        model: 'claude-test',
        messages: [{ role: 'user', content: 'coordinate the team' }],
        tools: [{ name: 'do_thing', input_schema: { type: 'object', properties: {} } }],
        team: {
          workspace_id: 'workspace:run-team-sequential',
          owner_role: 'lead',
          coordination_policy: 'sequential',
          assignments: [
            { stage: 0, task_id: taskIds[0], task_kind: 'compute', delegate_role: 'delegate', delegate_id: 'delegate-1', handoff_id: 'handoff-1', handoff_kind: 'compute' },
            { stage: 1, task_id: taskIds[1], task_kind: 'review', delegate_role: 'delegate', delegate_id: 'delegate-2', handoff_id: 'handoff-2', handoff_kind: 'review' },
          ],
        },
      },
      'full',
      {
        callTool: async (_name: string, input: { task_id: string }) => {
          callOrder.push(input.task_id);
          if (input.task_id === taskIds[0]) {
            firstLaunchReady?.();
            await barrier;
          }
          return { content: [{ type: 'text', text: `tool:${input.task_id}` }], isError: false };
        },
        createMessage: async params => {
          const taskId = taskIdFromMessages(params.messages, taskIds);
          return hasToolResult(params.messages)
            ? { model: 'claude-test', role: 'assistant', content: { type: 'text', text: `${taskId} complete` }, stopReason: 'endTurn' }
            : { model: 'claude-test', role: 'assistant', content: { type: 'tool_use', id: `tu_${taskId}`, name: 'do_thing', input: { task_id: taskId } }, stopReason: 'tool_use' };
        },
      },
    );

    await Promise.race([firstLaunch, new Promise<void>((_, reject) => setTimeout(() => reject(new Error('first sequential launch not observed')), 50))]);
    expect(callOrder).toEqual([taskIds[0]]);
    releaseBarrier?.();

    const payload = extractPayload(await resultPromise) as {
      assignment_results: Array<{ task_id: string; status: string }>;
      live_status: { coordination_policy: string; terminal_assignments: Array<{ task_id: string }> };
      replay: Array<{ kind: string }>;
    };

    expect(callOrder).toEqual(taskIds);
    expect(payload.assignment_results.map(item => [item.task_id, item.status])).toEqual([
      [taskIds[0], 'completed'],
      [taskIds[1], 'completed'],
    ]);
    expect(payload.live_status.coordination_policy).toBe('sequential');
    expect(payload.live_status.terminal_assignments.map(item => item.task_id)).toEqual(taskIds);
    expect(payload.replay.some(entry => entry.kind === 'stage_started' || entry.kind === 'stage_blocked')).toBe(false);
  });

  it('replays sequential recovery through orch_run_execute_agent without relaunching completed assignments', async () => {
    const projectRoot = makeTmpDir();
    await handleToolCall('orch_run_create', { project_root: projectRoot, run_id: 'run-team-sequential-resume', workflow_id: 'runtime' }, 'full');

    const taskIds = ['task-host-complete-1', 'task-host-recover-2', 'task-host-complete-3'];
    const first = extractPayload(await handleToolCall(
      'orch_run_execute_agent',
      {
        _confirm: true,
        project_root: projectRoot,
        run_id: 'run-team-sequential-resume',
        model: 'claude-test',
        messages: [{ role: 'user', content: 'coordinate the team' }],
        tools: [{ name: 'do_thing', input_schema: { type: 'object', properties: {} } }],
        team: {
          workspace_id: 'workspace:run-team-sequential-resume',
          owner_role: 'lead',
          coordination_policy: 'sequential',
          assignments: [
            { stage: 0, task_id: taskIds[0], task_kind: 'compute', delegate_role: 'delegate', delegate_id: 'delegate-1' },
            { stage: 1, task_id: taskIds[1], task_kind: 'review', delegate_role: 'delegate', delegate_id: 'delegate-2' },
            { stage: 2, task_id: taskIds[2], task_kind: 'compute', delegate_role: 'delegate', delegate_id: 'delegate-3' },
          ],
        },
      },
      'full',
      {
        callTool: async () => ({ content: [{ type: 'text', text: 'tool-result' }], isError: false }),
        createMessage: async params => {
          const taskId = taskIdFromMessages(params.messages, taskIds);
          if (taskId === taskIds[0] || taskId === taskIds[2]) {
            return { model: 'claude-test', role: 'assistant', content: { type: 'text', text: `${taskId} complete` }, stopReason: 'endTurn' };
          }
          if (hasToolResult(params.messages)) throw new Error('interrupt after checkpoint');
          return { model: 'claude-test', role: 'assistant', content: { type: 'tool_use', id: 'tu_host_sequential_recover', name: 'do_thing', input: { task_id: taskId } }, stopReason: 'tool_use' };
        },
      },
    )) as {
      assignment_results: Array<{ task_id: string; status: string }>;
      live_status: { active_assignments: Array<{ task_id: string }> };
      replay: Array<{ kind: string }>;
    };

    expect(first.assignment_results.map(item => [item.task_id, item.status])).toEqual([
      [taskIds[0], 'completed'],
      [taskIds[1], 'needs_recovery'],
      [taskIds[2], 'completed'],
    ]);
    expect(first.live_status.active_assignments.map(item => item.task_id)).toEqual([taskIds[1]]);
    expect(first.replay.some(entry => entry.kind === 'stage_blocked')).toBe(false);

    const resumedCallTool = vi.fn(async () => ({ content: [{ type: 'text', text: 'should-not-run' }], isError: false }));
    const resumed = extractPayload(await handleToolCall(
      'orch_run_execute_agent',
      {
        _confirm: true,
        project_root: projectRoot,
        run_id: 'run-team-sequential-resume',
        model: 'claude-test',
        messages: [
          { role: 'user', content: 'resume the team' },
          { role: 'assistant', content: [{ type: 'tool_use', id: 'tu_host_sequential_recover', name: 'do_thing', input: { task_id: taskIds[1] } }] },
        ],
        tools: [{ name: 'do_thing', input_schema: { type: 'object', properties: {} } }],
        team: {
          workspace_id: 'workspace:run-team-sequential-resume',
          owner_role: 'lead',
          coordination_policy: 'sequential',
          assignments: [
            { stage: 0, task_id: taskIds[0], task_kind: 'compute', delegate_role: 'delegate', delegate_id: 'delegate-1' },
            { stage: 1, task_id: taskIds[1], task_kind: 'review', delegate_role: 'delegate', delegate_id: 'delegate-2' },
            { stage: 2, task_id: taskIds[2], task_kind: 'compute', delegate_role: 'delegate', delegate_id: 'delegate-3' },
          ],
        },
      },
      'full',
      {
        callTool: resumedCallTool,
        createMessage: async params => {
          const taskId = taskIdFromMessages(params.messages, taskIds);
          return { model: 'claude-test', role: 'assistant', content: { type: 'text', text: `${taskId} resumed` }, stopReason: 'endTurn' };
        },
      },
    )) as {
      assignment_results: Array<{ task_id: string; status: string }>;
      replay: Array<{ kind: string }>;
      live_status: { active_assignments: Array<unknown> };
    };

    expect(resumed.assignment_results.map(item => [item.task_id, item.status])).toEqual([
      [taskIds[0], 'completed'],
      [taskIds[1], 'completed'],
      [taskIds[2], 'completed'],
    ]);
    expect(resumedCallTool).not.toHaveBeenCalled();
    expect(resumed.replay.filter(entry => entry.kind === 'checkpoint_restored')).toHaveLength(1);
    expect(resumed.live_status.active_assignments).toEqual([]);
  });
});
