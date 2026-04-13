import type { ComputationResultV1 } from '@autoresearch/shared';
import { createTeamExecutionState } from '../team-execution-state.js';
import type { TeamExecutionState } from '../team-execution-types.js';
import { TeamExecutionStateManager } from '../team-execution-storage.js';
import { defaultTeamPermissions } from '../team-execution-tool-bridge.js';
import {
  buildTeamConfigForDelegatedFollowupTask,
  primeDelegatedFollowupTeamState,
  type DelegatedFollowupTeamConfig,
} from './feedback-followups.js';
import {
  selectDelegatedFeedbackFollowupTask,
  type DelegatedFeedbackFollowupTask,
} from './feedback-followup-selection.js';

export type FeedbackFollowupLaunchStatus =
  | 'launched'
  | 'skipped_no_pending_task'
  | 'skipped_invalid_team_execution'
  | 'launch_failed';

export type FeedbackFollowupLaunchResult = {
  status: FeedbackFollowupLaunchStatus;
  task_id?: string;
  task_kind?: 'idea' | 'literature';
  assignment_id?: string;
  team_state_path?: string;
  error?: string;
};

type FeedbackAssignmentState = Pick<TeamExecutionState, 'delegate_assignments'> | null;

export type FeedbackFollowupLaunchOutcome = {
  launchResult: FeedbackFollowupLaunchResult;
  teamState: FeedbackAssignmentState;
};

function ensureDelegatedFollowupTeamState(params: {
  manager: TeamExecutionStateManager;
  runId: string;
  team: DelegatedFollowupTeamConfig;
}): void {
  if (params.manager.load(params.runId)) return;
  params.manager.save(createTeamExecutionState({
    workspace_id: params.team.workspace_id,
    coordination_policy: params.team.coordination_policy,
    permissions: defaultTeamPermissions(),
    assignment: {
      owner_role: params.team.owner_role,
      delegate_role: params.team.delegate_role,
      delegate_id: params.team.delegate_id,
      task_id: params.team.task_id,
      task_kind: params.team.task_kind,
      handoff_id: params.team.handoff_id,
      handoff_kind: params.team.handoff_kind,
      checkpoint_id: params.team.checkpoint_id,
    },
  }, params.runId));
}

export async function progressDelegatedFeedbackFollowups(params: {
  computationResult: ComputationResultV1;
  projectRoot: string;
  runId: string;
  launchTask: (params: {
    computationResult: ComputationResultV1;
    projectRoot: string;
    runId: string;
    task: DelegatedFeedbackFollowupTask;
    team: DelegatedFollowupTeamConfig;
  }) => Promise<FeedbackFollowupLaunchOutcome>;
}): Promise<FeedbackFollowupLaunchResult> {
  const manager = new TeamExecutionStateManager(params.projectRoot);
  const task = selectDelegatedFeedbackFollowupTask({
    computationResult: params.computationResult,
    teamState: manager.load(params.runId),
  });
  if (!task) {
    return { status: 'skipped_no_pending_task' };
  }

  let team: DelegatedFollowupTeamConfig;
  try {
    team = buildTeamConfigForDelegatedFollowupTask(task);
  } catch (error) {
    return {
      status: 'skipped_invalid_team_execution',
      task_id: task.task_id,
      task_kind: task.kind,
      error: error instanceof Error ? error.message : String(error),
    };
  }

  primeDelegatedFollowupTeamState({
    projectRoot: params.projectRoot,
    runId: params.runId,
    team,
  });
  ensureDelegatedFollowupTeamState({
    manager: new TeamExecutionStateManager(params.projectRoot),
    runId: params.runId,
    team,
  });
  const launched = await params.launchTask({
    computationResult: params.computationResult,
    projectRoot: params.projectRoot,
    runId: params.runId,
    task,
    team,
  });
  return launched.launchResult;
}
