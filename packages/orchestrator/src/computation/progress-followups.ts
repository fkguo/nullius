import type { ComputationResultV1 } from '@autoresearch/shared';
import type { DelegatedFollowupTeamConfig } from './feedback-followups.js';
import type {
  DelegatedComputationFollowupLaunchOutcome,
  DelegatedComputationFollowupLaunchResult,
} from './delegated-followup-progression.js';
import {
  progressDelegatedComputationFollowups,
} from './delegated-followup-progression.js';
import type {
  DelegatedFeedbackFollowupTask,
} from './feedback-followup-selection.js';
import type { DelegatedComputationFollowupTask } from './delegated-followup-selection.js';
import type {
  FeedbackFollowupLaunchOutcome,
  FeedbackFollowupLaunchResult,
} from './feedback-followup-progression.js';
import {
  progressDelegatedFeedbackFollowups,
} from './feedback-followup-progression.js';

export type ProgressFollowupsStatus =
  | 'launched'
  | 'skipped_no_pending_task'
  | 'skipped_invalid_team_execution'
  | 'launch_failed';

export type ProgressFollowupsBranch = 'feedback' | 'writing_review' | 'none';

export type ProgressFollowupsResult = {
  status: ProgressFollowupsStatus;
  branch: ProgressFollowupsBranch;
  task_id?: string;
  task_kind?: 'literature' | 'idea' | 'draft_update' | 'review';
  assignment_id?: string;
  team_state_path?: string;
  error?: string;
};

function hasPendingLiteratureFollowup(computationResult: ComputationResultV1): boolean {
  const literatureTasks = computationResult.workspace_feedback.tasks.filter(task => task.kind === 'literature');
  if (literatureTasks.some(task => task.status === 'pending')) {
    return true;
  }
  if (literatureTasks.length > 0) {
    return false;
  }
  return computationResult.next_actions.some(action =>
    action.task_kind === 'literature' || action.action_kind === 'literature_followup',
  );
}

function toFeedbackBranchResult(result: FeedbackFollowupLaunchResult): ProgressFollowupsResult {
  return {
    status: result.status,
    branch: result.status === 'skipped_no_pending_task' ? 'none' : 'feedback',
    ...(result.task_id ? { task_id: result.task_id } : {}),
    ...(result.task_kind ? { task_kind: result.task_kind } : {}),
    ...(result.assignment_id ? { assignment_id: result.assignment_id } : {}),
    ...(result.team_state_path ? { team_state_path: result.team_state_path } : {}),
    ...(result.error ? { error: result.error } : {}),
  };
}

function toWritingBranchResult(result: DelegatedComputationFollowupLaunchResult): ProgressFollowupsResult {
  if (result.status === 'skipped_no_pending_task') {
    return { status: 'skipped_no_pending_task', branch: 'none' };
  }
  if (result.status === 'skipped_invalid_team_execution') {
    return {
      status: 'skipped_invalid_team_execution',
      branch: 'writing_review',
      ...(result.task_id ? { task_id: result.task_id } : {}),
      ...(result.task_kind ? { task_kind: result.task_kind } : {}),
      ...(result.error ? { error: result.error } : {}),
    };
  }
  if (result.status !== 'launched') {
    return {
      status: 'launch_failed',
      branch: 'writing_review',
      ...(result.task_id ? { task_id: result.task_id } : {}),
      ...(result.task_kind ? { task_kind: result.task_kind } : {}),
      ...(result.error ? { error: result.error } : {}),
    };
  }
  return {
    status: 'launched',
    branch: 'writing_review',
    ...(result.task_id ? { task_id: result.task_id } : {}),
    ...(result.task_kind ? { task_kind: result.task_kind } : {}),
    ...(result.assignment_id ? { assignment_id: result.assignment_id } : {}),
    ...(result.team_state_path ? { team_state_path: result.team_state_path } : {}),
  };
}

export async function progressRunFollowups(params: {
  computationResult: ComputationResultV1;
  projectRoot: string;
  runId: string;
  runDir: string;
  launchFeedbackTask: (params: {
    computationResult: ComputationResultV1;
    projectRoot: string;
    runId: string;
    task: DelegatedFeedbackFollowupTask;
    team: DelegatedFollowupTeamConfig;
  }) => Promise<FeedbackFollowupLaunchOutcome>;
  launchWritingReviewTask: (params: {
    computationResult: ComputationResultV1;
    projectRoot: string;
    runId: string;
    task: DelegatedComputationFollowupTask;
    team: DelegatedFollowupTeamConfig;
  }) => Promise<DelegatedComputationFollowupLaunchOutcome>;
}): Promise<ProgressFollowupsResult> {
  const feedbackResult = await progressDelegatedFeedbackFollowups({
    computationResult: params.computationResult,
    projectRoot: params.projectRoot,
    runId: params.runId,
    launchTask: async launchParams => params.launchFeedbackTask({
      computationResult: launchParams.computationResult,
      projectRoot: launchParams.projectRoot,
      runId: launchParams.runId,
      task: launchParams.task,
      team: launchParams.team,
    }),
  });
  if (feedbackResult.status !== 'skipped_no_pending_task') {
    return toFeedbackBranchResult(feedbackResult);
  }

  const writingReviewResult = await progressDelegatedComputationFollowups({
    computationResult: params.computationResult,
    projectRoot: params.projectRoot,
    runId: params.runId,
    runDir: params.runDir,
    allowImmediateReviewReselection: false,
    launchTask: async launchParams => params.launchWritingReviewTask({
      computationResult: launchParams.computationResult,
      projectRoot: launchParams.projectRoot,
      runId: launchParams.runId,
      task: launchParams.task,
      team: launchParams.team,
    }),
  });
  if (writingReviewResult.status !== 'skipped_no_pending_task') {
    return toWritingBranchResult(writingReviewResult);
  }

  if (hasPendingLiteratureFollowup(params.computationResult)) {
    return {
      status: 'skipped_invalid_team_execution',
      branch: 'feedback',
      task_kind: 'literature',
      error: 'literature follow-up is pending but missing delegated feedback authority',
    };
  }

  return { status: 'skipped_no_pending_task', branch: 'none' };
}
