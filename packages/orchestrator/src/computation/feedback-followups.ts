import { randomUUID } from 'node:crypto';
import { utcNowIso } from '../util.js';
import { type ResearchHandoff, type ResearchLoopRuntime } from '../research-loop/index.js';
import type { WritingFollowupWorkspaceSeed } from './followup-bridges.js';

function runtimeHandoff(
  runId: string,
  sourceTaskId: string,
  seed: NonNullable<WritingFollowupWorkspaceSeed['handoff']> | NonNullable<WritingFollowupWorkspaceSeed['reviewTask']>['handoff'],
): ResearchHandoff {
  const base = {
    handoff_id: randomUUID(),
    workspace_id: `workspace:${runId}`,
    source_task_id: sourceTaskId,
    target_node_id: seed.target_node_id,
    source: 'system' as const,
    actor_id: null,
    created_at: utcNowIso(),
  };
  if (seed.handoff_kind === 'writing') {
    return { ...base, handoff_kind: 'writing', payload: seed.payload };
  }
  return { ...base, handoff_kind: 'review', payload: seed.payload };
}

export function appendWritingFollowups(
  runtime: ResearchLoopRuntime,
  runId: string,
  findingTaskId: string,
  writingSeed?: WritingFollowupWorkspaceSeed,
): void {
  if (!writingSeed) return;
  const draftTask = writingSeed.handoff
    ? runtime.appendDelegatedTask({
        handoff: runtimeHandoff(runId, findingTaskId, writingSeed.handoff),
        task: writingSeed.task,
      })
    : runtime.spawnFollowupTask(findingTaskId, writingSeed.task);
  if (!writingSeed.reviewTask) return;
  runtime.appendDelegatedTask({
    handoff: runtimeHandoff(runId, draftTask.task_id, writingSeed.reviewTask.handoff),
    task: writingSeed.reviewTask.task,
  });
}
