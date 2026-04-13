import { randomUUID } from 'node:crypto';
import { utcNowIso } from '../util.js';
import type { ResearchHandoff } from '../research-loop/handoff-types.js';
import type { ResearchLoopRuntime } from '../research-loop/runtime.js';
import {
  buildResearchTaskExecutionRef,
  isResearchTaskExecutionRef,
  type ResearchTaskExecutionRef,
} from '../research-loop/task-execution-ref.js';
import {
  createResearchTaskExecutionRefRegistry,
  upsertResearchTaskExecutionRef,
} from '../research-task-execution-ref.js';
import type { ResearchTask } from '../research-loop/task-types.js';
import { TeamExecutionStateManager } from '../team-execution-storage.js';
import type { WritingFollowupWorkspaceSeed } from './followup-bridges.js';

type DelegatedFollowupTask = Pick<ResearchTask, 'task_id' | 'kind' | 'metadata'>;
type DelegatedFollowupTaskKind = Extract<ResearchTask['kind'], 'idea' | 'draft_update' | 'review'>;
type DelegatedFollowupHandoffKind = Extract<ResearchHandoff['handoff_kind'], 'feedback' | 'writing' | 'review'>;
type DelegatedFollowupHandoff = Extract<ResearchHandoff, { handoff_kind: DelegatedFollowupHandoffKind }>;
type DelegatedFollowupTeamExecutionMetadata = {
  workspace_id: string;
  owner_role: 'lead';
  delegate_role: 'delegate';
  delegate_id: 'delegate-1';
  coordination_policy: 'supervised_delegate';
  research_task_ref: ResearchTaskExecutionRef;
  handoff_id: string;
  handoff_kind: DelegatedFollowupHandoffKind;
  checkpoint_id: null;
};

export type DelegatedFollowupTeamConfig = DelegatedFollowupTeamExecutionMetadata & {
  task_id: string;
  task_kind: DelegatedFollowupTaskKind;
};

function isDelegatedFollowupTaskKind(kind: ResearchTask['kind']): kind is DelegatedFollowupTaskKind {
  return kind === 'idea' || kind === 'draft_update' || kind === 'review';
}

function isDelegatedFollowupTeamExecutionMetadata(
  value: unknown,
): value is DelegatedFollowupTeamExecutionMetadata {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  return candidate.workspace_id !== undefined
    && typeof candidate.workspace_id === 'string'
    && candidate.owner_role === 'lead'
    && candidate.delegate_role === 'delegate'
    && candidate.delegate_id === 'delegate-1'
    && candidate.coordination_policy === 'supervised_delegate'
    && isResearchTaskExecutionRef(candidate.research_task_ref)
    && typeof candidate.handoff_id === 'string'
    && (candidate.handoff_kind === 'feedback' || candidate.handoff_kind === 'writing' || candidate.handoff_kind === 'review')
    && candidate.checkpoint_id === null;
}

export function attachDelegatedFollowupTeamExecutionMetadata(task: ResearchTask, handoff: DelegatedFollowupHandoff): void {
  const researchTaskRef = buildResearchTaskExecutionRef({
    task,
    workspace_id: handoff.workspace_id,
    handoff,
  });
  const metadata = task.metadata ?? {};
  task.metadata = {
    ...metadata,
    team_execution: {
      workspace_id: handoff.workspace_id,
      owner_role: 'lead',
      delegate_role: 'delegate',
      delegate_id: 'delegate-1',
      coordination_policy: 'supervised_delegate',
      research_task_ref: researchTaskRef,
      handoff_id: handoff.handoff_id,
      handoff_kind: handoff.handoff_kind,
      checkpoint_id: null,
    },
  };
}

export function buildTeamConfigForDelegatedFollowupTask(
  task: DelegatedFollowupTask,
): DelegatedFollowupTeamConfig {
  if (!isDelegatedFollowupTaskKind(task.kind)) {
    throw new Error(`task ${task.task_id} is not a delegated follow-up task`);
  }
  const teamExecution = task.metadata && typeof task.metadata === 'object'
    ? (task.metadata as Record<string, unknown>).team_execution
    : null;
  if (!isDelegatedFollowupTeamExecutionMetadata(teamExecution)) {
    throw new Error(`task ${task.task_id} is missing delegated team execution metadata`);
  }
  const researchTaskRef: ResearchTaskExecutionRef = { ...teamExecution.research_task_ref };
  return {
    workspace_id: teamExecution.workspace_id,
    owner_role: teamExecution.owner_role,
    delegate_role: teamExecution.delegate_role,
    delegate_id: teamExecution.delegate_id,
    coordination_policy: teamExecution.coordination_policy,
    research_task_ref: researchTaskRef,
    handoff_id: teamExecution.handoff_id,
    handoff_kind: teamExecution.handoff_kind,
    checkpoint_id: teamExecution.checkpoint_id,
    task_id: task.task_id,
    task_kind: task.kind,
  };
}

export function primeDelegatedFollowupTeamState(params: {
  projectRoot: string;
  runId: string;
  team: DelegatedFollowupTeamConfig;
}): void {
  const manager = new TeamExecutionStateManager(params.projectRoot);
  const registry = manager.loadTaskRefRegistry(params.runId)
    ?? createResearchTaskExecutionRefRegistry(params.runId);
  upsertResearchTaskExecutionRef(
    registry,
    { ...params.team.research_task_ref },
  );
  manager.saveTaskRefRegistry(registry);
}

function runtimeHandoff(
  runId: string,
  sourceTaskId: string,
  seed: NonNullable<WritingFollowupWorkspaceSeed['handoff']> | NonNullable<WritingFollowupWorkspaceSeed['reviewTask']>['handoff'],
): DelegatedFollowupHandoff {
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
  const draftHandoff = writingSeed.handoff
    ? runtimeHandoff(runId, findingTaskId, writingSeed.handoff)
    : null;
  const draftTask = draftHandoff
    ? runtime.appendDelegatedTask({ handoff: draftHandoff, task: writingSeed.task })
    : runtime.spawnFollowupTask(findingTaskId, writingSeed.task);
  if (draftHandoff) {
    attachDelegatedFollowupTeamExecutionMetadata(draftTask, draftHandoff);
  }
  if (!writingSeed.reviewTask) return;
  const reviewHandoff = runtimeHandoff(runId, draftTask.task_id, writingSeed.reviewTask.handoff);
  const reviewTask = runtime.appendDelegatedTask({
    handoff: reviewHandoff,
    task: writingSeed.reviewTask.task,
  });
  attachDelegatedFollowupTeamExecutionMetadata(reviewTask, reviewHandoff);
}
