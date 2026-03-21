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
  if (!taskId) throw new Error('missing stage-gated recovery task protocol');
  return taskId;
}

function hasToolResult(messages: Array<{ role: string; content: unknown }>): boolean {
  const last = messages.at(-1);
  const blocks = last ? (Array.isArray(last.content) ? last.content : [last.content]) : [];
  return blocks.some(block => Boolean(block && typeof block === 'object' && 'type' in block && block.type === 'tool_result'));
}

describe('orch_run_execute_agent stage-gated recovery bridge', () => {
  it('replays blocked-stage recovery through the shared host path without relaunching completed earlier stages', async () => {
    const projectRoot = makeTmpDir();
    await handleToolCall(
      'orch_run_create',
      { project_root: projectRoot, run_id: 'run-team-stage-gated-recovery', workflow_id: 'runtime' },
      'full',
    );

    const taskIds = ['task-host-stage-complete', 'task-host-stage-recover', 'task-host-stage-later'];
    const first = extractPayload(await handleToolCall(
      'orch_run_execute_agent',
      {
        _confirm: true,
        project_root: projectRoot,
        run_id: 'run-team-stage-gated-recovery',
        model: 'claude-test',
        messages: [{ role: 'user', content: 'coordinate the team' }],
        tools: [{ name: 'do_thing', input_schema: { type: 'object', properties: {} } }],
        team: {
          workspace_id: 'workspace:run-team-stage-gated-recovery',
          owner_role: 'lead',
          coordination_policy: 'stage_gated',
          assignments: [
            { stage: 0, task_id: taskIds[0], task_kind: 'compute', delegate_role: 'delegate', delegate_id: 'delegate-1', handoff_id: 'handoff-1', handoff_kind: 'compute' },
            { stage: 1, task_id: taskIds[1], task_kind: 'review', delegate_role: 'delegate', delegate_id: 'delegate-2', handoff_id: 'handoff-2', handoff_kind: 'review' },
            { stage: 2, task_id: taskIds[2], task_kind: 'compute', delegate_role: 'delegate', delegate_id: 'delegate-3', handoff_id: 'handoff-3', handoff_kind: 'compute' },
          ],
        },
      },
      'full',
      {
        callTool: async () => ({ content: [{ type: 'text', text: 'tool-result' }], isError: false }),
        createMessage: async params => {
          const taskId = taskIdFromMessages(params.messages, taskIds);
          if (taskId === taskIds[0]) {
            return { model: 'claude-test', role: 'assistant', content: { type: 'text', text: `${taskId} complete` }, stopReason: 'endTurn' };
          }
          if (taskId === taskIds[1] && !hasToolResult(params.messages)) {
            return { model: 'claude-test', role: 'assistant', content: { type: 'tool_use', id: 'tu_host_stage_recover', name: 'do_thing', input: { task_id: taskId } }, stopReason: 'tool_use' };
          }
          if (taskId === taskIds[1] && hasToolResult(params.messages)) {
            throw new Error('interrupt after checkpoint');
          }
          throw new Error('later stages should stay blocked on the first run');
        },
      },
    )) as {
      assignment_results: Array<{ task_id: string; status: string }>;
      blocked_stage: number | null;
      replay: Array<{ kind: string; payload: { stage?: number } }>;
    };

    expect(first.assignment_results.map(item => [item.task_id, item.status])).toEqual([
      [taskIds[0], 'completed'],
      [taskIds[1], 'needs_recovery'],
    ]);
    expect(first.blocked_stage).toBe(1);
    expect(first.replay.some(entry => entry.kind === 'stage_blocked' && entry.payload.stage === 1)).toBe(true);

    const resumedTasks: string[] = [];
    const resumedCallTool = vi.fn(async () => ({ content: [{ type: 'text', text: 'should-not-run' }], isError: false }));
    const resumed = extractPayload(await handleToolCall(
      'orch_run_execute_agent',
      {
        _confirm: true,
        project_root: projectRoot,
        run_id: 'run-team-stage-gated-recovery',
        model: 'claude-test',
        messages: [
          { role: 'user', content: 'resume the team' },
          { role: 'assistant', content: [{ type: 'tool_use', id: 'tu_host_stage_recover', name: 'do_thing', input: { task_id: taskIds[1] } }] },
        ],
        tools: [{ name: 'do_thing', input_schema: { type: 'object', properties: {} } }],
        team: {
          workspace_id: 'workspace:run-team-stage-gated-recovery',
          owner_role: 'lead',
          coordination_policy: 'stage_gated',
          assignments: [
            { stage: 0, task_id: taskIds[0], task_kind: 'compute', delegate_role: 'delegate', delegate_id: 'delegate-1', handoff_id: 'handoff-1', handoff_kind: 'compute' },
            { stage: 1, task_id: taskIds[1], task_kind: 'review', delegate_role: 'delegate', delegate_id: 'delegate-2', handoff_id: 'handoff-2', handoff_kind: 'review' },
            { stage: 2, task_id: taskIds[2], task_kind: 'compute', delegate_role: 'delegate', delegate_id: 'delegate-3', handoff_id: 'handoff-3', handoff_kind: 'compute' },
          ],
        },
      },
      'full',
      {
        callTool: resumedCallTool,
        createMessage: async params => {
          const taskId = taskIdFromMessages(params.messages, taskIds);
          resumedTasks.push(taskId);
          if (taskId === taskIds[0]) throw new Error('completed earlier stages should not relaunch');
          return {
            model: 'claude-test',
            role: 'assistant',
            content: { type: 'text', text: `${taskId} resumed` },
            stopReason: 'endTurn',
          };
        },
      },
    )) as {
      assignment_results: Array<{ task_id: string; status: string }>;
      blocked_stage: number | null;
      live_status: { active_assignments: Array<unknown> };
      replay: Array<{ kind: string; payload: { stage?: number } }>;
    };

    expect(resumedTasks).toEqual([taskIds[1], taskIds[2]]);
    expect(resumedCallTool).not.toHaveBeenCalled();
    expect(resumed.blocked_stage).toBeNull();
    expect(resumed.assignment_results.map(item => [item.task_id, item.status])).toEqual([
      [taskIds[0], 'completed'],
      [taskIds[1], 'completed'],
      [taskIds[2], 'completed'],
    ]);
    expect(resumed.replay.filter(entry => entry.kind === 'checkpoint_restored')).toHaveLength(1);
    expect(resumed.replay.filter(entry => entry.kind === 'stage_blocked' && entry.payload.stage === 1)).toHaveLength(1);
    expect(resumed.live_status.active_assignments).toEqual([]);
  });
});
