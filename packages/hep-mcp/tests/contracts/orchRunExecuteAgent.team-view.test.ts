import { describe, expect, it } from 'vitest';

import { handleToolCall } from '../../src/tools/index.js';
import { extractPayload, makeTmpDir } from './orchRunExecuteAgentTestSupport.js';

describe('orch_run_execute_agent team control-plane views', () => {
  it('returns unified live-status and replay views for a stage_gated multi-assignment team runtime', async () => {
    const projectRoot = makeTmpDir();
    await handleToolCall(
      'orch_run_create',
      { project_root: projectRoot, run_id: 'run-team-multi', workflow_id: 'runtime' },
      'full',
    );

    const payload = extractPayload(await handleToolCall(
      'orch_run_execute_agent',
      {
        _confirm: true,
        project_root: projectRoot,
        run_id: 'run-team-multi',
        model: 'claude-test',
        messages: [{ role: 'user', content: 'coordinate the team' }],
        tools: [],
        team: {
          workspace_id: 'workspace:run-team-multi',
          owner_role: 'lead',
          coordination_policy: 'stage_gated',
          assignments: [
            { stage: 0, task_id: 'task-compute-1', task_kind: 'compute', delegate_role: 'delegate', delegate_id: 'delegate-1', handoff_id: 'handoff-compute-1', handoff_kind: 'compute' },
            { stage: 1, task_id: 'task-review-2', task_kind: 'review', delegate_role: 'delegate', delegate_id: 'delegate-2', handoff_id: 'handoff-review-2', handoff_kind: 'review' },
          ],
        },
      },
      'full',
      {
        createMessage: async () => ({
          model: 'claude-test',
          role: 'assistant',
          content: { type: 'text', text: 'done' },
          stopReason: 'endTurn',
        }),
      },
    )) as {
      assignment_results: Array<{ task_id: string; stage: number }>;
      live_status: { terminal_assignments: Array<{ task_id: string }> };
      replay: Array<{ kind: string; payload: { stage?: number } }>;
    };

    expect(payload.assignment_results).toHaveLength(2);
    expect(payload.assignment_results.map(item => item.task_id)).toEqual(['task-compute-1', 'task-review-2']);
    expect(payload.live_status.terminal_assignments).toHaveLength(2);
    expect(payload.replay.some(entry => entry.kind === 'stage_started' && entry.payload.stage === 0)).toBe(true);
  });
});
