import type { ComputationResultV1 } from '@autoresearch/shared';
import type { TeamExecutionState } from '../team-execution-types.js';

type FollowupTask = ComputationResultV1['workspace_feedback']['tasks'][number];
export type DelegatedFeedbackFollowupTask = Omit<FollowupTask, 'kind'> & { kind: 'idea' };

function hasTeamExecutionKey(task: FollowupTask): boolean {
  return Boolean(
    task.metadata
    && typeof task.metadata === 'object'
    && Object.prototype.hasOwnProperty.call(task.metadata, 'team_execution'),
  );
}

function hasFeedbackHandoff(task: FollowupTask): boolean {
  if (!task.metadata || typeof task.metadata !== 'object') return false;
  const teamExecution = (task.metadata as Record<string, unknown>).team_execution;
  return Boolean(
    teamExecution
    && typeof teamExecution === 'object'
    && (teamExecution as Record<string, unknown>).handoff_kind === 'feedback',
  );
}

function isDelegatedFeedbackLaunchCandidate(task: FollowupTask): task is DelegatedFeedbackFollowupTask {
  return task.kind === 'idea' && task.status === 'pending' && hasTeamExecutionKey(task) && hasFeedbackHandoff(task);
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

export function hasCompletedDelegatedFeedbackAssignmentForTask(
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

export function selectDelegatedFeedbackFollowupTask(params: {
  computationResult: ComputationResultV1;
  teamState: Pick<TeamExecutionState, 'delegate_assignments'> | null;
}): DelegatedFeedbackFollowupTask | null {
  const matches = params.computationResult.workspace_feedback.tasks.filter(isDelegatedFeedbackLaunchCandidate);
  for (const match of matches) {
    if (hasNonTerminalAssignmentForTask(params.teamState, match.task_id)) continue;
    if (hasCompletedDelegatedFeedbackAssignmentForTask(params.teamState, match.task_id)) continue;
    return match;
  }
  return null;
}
