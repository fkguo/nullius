import type { ComputationResultV1 } from '@autoresearch/shared';
import type { TeamExecutionState } from '../team-execution-types.js';
import type { ResearchTaskExecutionRefRegistry } from '../research-task-execution-ref.js';

type FollowupTask = ComputationResultV1['workspace_feedback']['tasks'][number];
export type DelegatedComputationFollowupTask = Omit<FollowupTask, 'kind'> & { kind: 'draft_update' | 'review' };

function hasTeamExecutionKey(task: FollowupTask): boolean {
  return Boolean(
    task.metadata
    && typeof task.metadata === 'object'
    && Object.prototype.hasOwnProperty.call(task.metadata, 'team_execution'),
  );
}

function isDelegatedLaunchCandidate(
  task: FollowupTask,
  kind: DelegatedComputationFollowupTask['kind'],
): task is DelegatedComputationFollowupTask {
  return task.kind === kind && task.status === 'pending' && hasTeamExecutionKey(task);
}

function sourceTaskIdFromMetadata(task: FollowupTask): string | null {
  if (!task.metadata || typeof task.metadata !== 'object') return null;
  const teamExecution = (task.metadata as Record<string, unknown>).team_execution;
  if (!teamExecution || typeof teamExecution !== 'object') return null;
  const researchTaskRef = (teamExecution as Record<string, unknown>).research_task_ref;
  if (!researchTaskRef || typeof researchTaskRef !== 'object') return null;
  const sourceTaskId = (researchTaskRef as Record<string, unknown>).source_task_id;
  return typeof sourceTaskId === 'string' && sourceTaskId ? sourceTaskId : null;
}

function sourceTaskIdFor(
  task: FollowupTask,
  taskRefRegistry: ResearchTaskExecutionRefRegistry | null,
): string | null {
  return sourceTaskIdFromMetadata(task)
    ?? taskRefRegistry?.refs_by_task_id[task.task_id]?.source_task_id
    ?? null;
}

function isTerminalAssignmentStatus(status: TeamExecutionState['delegate_assignments'][number]['status']): boolean {
  return ['completed', 'failed', 'cancelled', 'timed_out', 'cascade_stopped'].includes(status);
}

function assignmentsForTask(
  teamState: Pick<TeamExecutionState, 'delegate_assignments'> | null,
  taskId: string,
): TeamExecutionState['delegate_assignments'] {
  if (!teamState) return [];
  return teamState.delegate_assignments.filter(assignment => assignment.task_id === taskId);
}

export function hasCompletedDelegatedFollowupAssignmentForTask(
  teamState: Pick<TeamExecutionState, 'delegate_assignments'> | null,
  taskId: string,
): boolean {
  return assignmentsForTask(teamState, taskId).some(assignment => assignment.status === 'completed');
}

function hasNonTerminalAssignmentForTask(
  teamState: Pick<TeamExecutionState, 'delegate_assignments'> | null,
  taskId: string,
): boolean {
  return assignmentsForTask(teamState, taskId).some(
    assignment => !isTerminalAssignmentStatus(assignment.status),
  );
}

export function selectDelegatedComputationFollowupTask(params: {
  computationResult: ComputationResultV1;
  teamState: Pick<TeamExecutionState, 'delegate_assignments'> | null;
  taskRefRegistry: ResearchTaskExecutionRefRegistry | null;
}): DelegatedComputationFollowupTask | null {
  const tasks = params.computationResult.workspace_feedback.tasks;
  for (const kind of ['draft_update', 'review'] as const) {
    const matches = tasks.filter(task => isDelegatedLaunchCandidate(task, kind));
    for (const match of matches) {
      if (hasNonTerminalAssignmentForTask(params.teamState, match.task_id)) continue;
      if (hasCompletedDelegatedFollowupAssignmentForTask(params.teamState, match.task_id)) continue;
      if (kind === 'review') {
        const upstreamTaskId = sourceTaskIdFor(match, params.taskRefRegistry);
        if (!upstreamTaskId) continue;
        if (!hasCompletedDelegatedFollowupAssignmentForTask(params.teamState, upstreamTaskId)) continue;
      }
      return match;
    }
  }
  return null;
}
