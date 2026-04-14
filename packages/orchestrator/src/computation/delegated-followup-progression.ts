import * as fs from 'node:fs';
import * as path from 'node:path';
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
  hasCompletedDelegatedFollowupAssignmentForTask,
  selectDelegatedComputationFollowupTask,
  type DelegatedComputationFollowupTask,
} from './delegated-followup-selection.js';
import { refreshReviewFollowupBridge } from './followup-bridges.js';
import { evaluateReviewFollowupGate } from './review-followup-gate.js';
import type { WritingReviewBridgeV1 } from '@autoresearch/shared';

export type DelegatedComputationFollowupLaunchStatus =
  | 'launched'
  | 'blocked_by_gate'
  | 'skipped_no_pending_task'
  | 'skipped_missing_task_scoped_output'
  | 'skipped_missing_host_context'
  | 'skipped_invalid_team_execution'
  | 'launch_failed';

export type DelegatedComputationFollowupLaunchResult = {
  status: DelegatedComputationFollowupLaunchStatus;
  task_id?: string;
  task_kind?: 'draft_update' | 'review';
  assignment_id?: string;
  team_state_path?: string;
  error?: string;
};

type DelegatedAssignmentState = Pick<TeamExecutionState, 'delegate_assignments'> | null;

export type DelegatedComputationFollowupLaunchOutcome = {
  launchResult: DelegatedComputationFollowupLaunchResult;
  teamState: DelegatedAssignmentState;
};

function sourceTaskIdFromMetadata(task: ComputationResultV1['workspace_feedback']['tasks'][number]): string | null {
  if (!task.metadata || typeof task.metadata !== 'object') return null;
  const teamExecution = (task.metadata as Record<string, unknown>).team_execution;
  if (!teamExecution || typeof teamExecution !== 'object') return null;
  const researchTaskRef = (teamExecution as Record<string, unknown>).research_task_ref;
  if (!researchTaskRef || typeof researchTaskRef !== 'object') return null;
  const sourceTaskId = (researchTaskRef as Record<string, unknown>).source_task_id;
  return typeof sourceTaskId === 'string' && sourceTaskId.length > 0 ? sourceTaskId : null;
}

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

async function launchDelegatedTask(params: {
  computationResult: ComputationResultV1;
  projectRoot: string;
  runId: string;
  task: DelegatedComputationFollowupTask;
  launchTask: (params: {
    computationResult: ComputationResultV1;
    projectRoot: string;
    runId: string;
    task: DelegatedComputationFollowupTask;
    team: DelegatedFollowupTeamConfig;
  }) => Promise<DelegatedComputationFollowupLaunchOutcome>;
}): Promise<DelegatedComputationFollowupLaunchOutcome> {
  let team: DelegatedFollowupTeamConfig;
  try {
    team = buildTeamConfigForDelegatedFollowupTask(params.task);
  } catch (error) {
    return {
      launchResult: {
        status: 'skipped_invalid_team_execution',
        task_id: params.task.task_id,
        task_kind: params.task.kind,
        error: error instanceof Error ? error.message : String(error),
      },
      teamState: null,
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
  return params.launchTask({
    computationResult: params.computationResult,
    projectRoot: params.projectRoot,
    runId: params.runId,
    task: params.task,
    team,
  });
}

export async function progressDelegatedComputationFollowups(params: {
  computationResult: ComputationResultV1;
  projectRoot: string;
  runId: string;
  runDir: string;
  allowImmediateReviewReselection?: boolean;
  launchTask: (params: {
    computationResult: ComputationResultV1;
    projectRoot: string;
    runId: string;
    task: DelegatedComputationFollowupTask;
    team: DelegatedFollowupTeamConfig;
  }) => Promise<DelegatedComputationFollowupLaunchOutcome>;
}): Promise<DelegatedComputationFollowupLaunchResult> {
  const teamStateManager = new TeamExecutionStateManager(params.projectRoot);
  const initialTask = selectDelegatedComputationFollowupTask({
    computationResult: params.computationResult,
    teamState: teamStateManager.load(params.runId),
    taskRefRegistry: teamStateManager.loadTaskRefRegistry(params.runId),
  });
  if (!initialTask) {
    return { status: 'skipped_no_pending_task' };
  }

  const firstLaunch = await launchDelegatedTask({
    computationResult: params.computationResult,
    projectRoot: params.projectRoot,
    runId: params.runId,
    task: initialTask,
    launchTask: params.launchTask,
  });
  if (firstLaunch.launchResult.status !== 'launched' || initialTask.kind !== 'draft_update') {
    return firstLaunch.launchResult;
  }
  if (params.allowImmediateReviewReselection === false) {
    return firstLaunch.launchResult;
  }

  const persistedPostLaunchTeamState = teamStateManager.load(params.runId);
  const postLaunchTeamState = persistedPostLaunchTeamState && hasCompletedDelegatedFollowupAssignmentForTask(
    persistedPostLaunchTeamState,
    initialTask.task_id,
  )
    ? persistedPostLaunchTeamState
    : (firstLaunch.teamState ?? persistedPostLaunchTeamState);
  if (!hasCompletedDelegatedFollowupAssignmentForTask(postLaunchTeamState, initialTask.task_id)) {
    return firstLaunch.launchResult;
  }

  const nextTask = selectDelegatedComputationFollowupTask({
    computationResult: params.computationResult,
    teamState: postLaunchTeamState,
    taskRefRegistry: teamStateManager.loadTaskRefRegistry(params.runId),
  });
  if (!nextTask || nextTask.kind !== 'review') {
    return firstLaunch.launchResult;
  }

  const upstreamDraftTaskId = sourceTaskIdFromMetadata(nextTask);
  if (!upstreamDraftTaskId) {
    return {
      status: 'skipped_missing_task_scoped_output',
      task_id: nextTask.task_id,
      task_kind: nextTask.kind,
      error: 'review follow-up is missing an upstream draft task linkage',
    };
  }

  const refreshedReviewBridge = refreshReviewFollowupBridge({
    runId: params.runId,
    runDir: params.runDir,
    computationResult: params.computationResult,
    reviewTaskId: nextTask.task_id,
    upstreamDraftTaskId,
  });
  if (!refreshedReviewBridge || refreshedReviewBridge.status === 'missing_task_scoped_output') {
    return {
      status: 'skipped_missing_task_scoped_output',
      task_id: nextTask.task_id,
      task_kind: nextTask.kind,
      error: 'no task-scoped staged draft output found for the upstream draft_update task',
    };
  }

  const refreshedBridge = JSON.parse(
    fs.readFileSync(path.join(params.runDir, 'artifacts', 'review_followup_bridge_v1.json'), 'utf-8'),
  ) as WritingReviewBridgeV1;
  const gateResult = evaluateReviewFollowupGate({
    bridge: refreshedBridge,
    runDir: params.runDir,
  });
  if (gateResult.decision === 'block') {
    return {
      status: 'blocked_by_gate',
      task_id: nextTask.task_id,
      task_kind: nextTask.kind,
      error: gateResult.reason ?? 'review follow-up is blocked by verification or integrity truth',
    };
  }

  const secondLaunch = await launchDelegatedTask({
    computationResult: params.computationResult,
    projectRoot: params.projectRoot,
    runId: params.runId,
    task: nextTask,
    launchTask: params.launchTask,
  });
  return secondLaunch.launchResult;
}
