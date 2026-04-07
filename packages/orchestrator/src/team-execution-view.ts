import type { ResearchTaskLifecycleProjection, ResearchTaskStatus } from './research-loop/task-types.js';
import type { TeamDelegationProtocol } from './delegation-protocol.js';
import {
  buildDelegatedExecutionIdentity,
  delegatedExecutionManifestPath,
} from './execution-identity.js';
import {
  taskProjectionFromAssignmentStatus,
} from './operator-read-model-summary.js';
import { derivePendingApprovals } from './team-execution-scoping.js';
import type {
  TeamPendingApproval,
  TeamAssignmentStatus,
  TeamCoordinationPolicy,
  TeamExecutionEvent,
  TeamExecutionState,
  TeamSessionContextKind,
} from './team-execution-types.js';

export interface TeamAssignmentView {
  assignment_id: string;
  agent_id: string;
  stage: number;
  status: TeamAssignmentStatus;
  workspace_id: string;
  task_id: string;
  task_kind: TeamExecutionState['delegate_assignments'][number]['task_kind'];
  handoff_id: string | null;
  handoff_kind: TeamExecutionState['delegate_assignments'][number]['handoff_kind'];
  checkpoint_id: string | null;
  timeout_at: string | null;
  last_heartbeat_at: string | null;
  manifest_path: string;
  runtime_run_id: string;
  session_id: string | null;
  session_parent_id: string | null;
  session_context_kind: TeamSessionContextKind | null;
  forked_from_assignment_id: string | null;
  forked_from_session_id: string | null;
  last_completed_step: string | null;
  resume_from: string | null;
  approval_id: string | null;
  approval_packet_path: string | null;
  approval_requested_at: string | null;
  delegation_protocol: TeamDelegationProtocol;
}

export type TeamPendingApprovalView = TeamPendingApproval;

export interface TeamBackgroundTaskView {
  assignment_id: string;
  agent_id: string;
  task_id: string;
  task_kind: TeamExecutionState['delegate_assignments'][number]['task_kind'];
  session_id: string | null;
  session_parent_id: string | null;
  session_context_kind: TeamSessionContextKind | null;
  forked_from_assignment_id: string | null;
  forked_from_session_id: string | null;
  runtime_run_id: string;
  runtime_status: TeamAssignmentStatus;
  task_lifecycle_status: ResearchTaskLifecycleProjection;
  task_status: ResearchTaskStatus;
  checkpoint_id: string | null;
  last_completed_step: string | null;
  resume_from: string | null;
  approval_id: string | null;
}

export interface TeamLiveStatusView {
  run_id: string;
  workspace_id: string;
  coordination_policy: TeamCoordinationPolicy;
  blocked_stage: number | null;
  active_assignment_ids: string[];
  active_assignments: TeamAssignmentView[];
  terminal_assignments: TeamAssignmentView[];
  pending_approvals: TeamPendingApprovalView[];
  background_tasks: TeamBackgroundTaskView[];
  updated_at: string;
}

export interface TeamReplayEntry {
  created_at: string;
  kind: TeamExecutionEvent['kind'];
  assignment_id: string | null;
  task_id: string | null;
  checkpoint_id: string | null;
  payload: Record<string, unknown>;
}

function currentSession(
  state: TeamExecutionState,
  assignment: TeamExecutionState['delegate_assignments'][number],
) {
  if (!assignment.session_id) return null;
  return state.sessions?.find(session => session.session_id === assignment.session_id) ?? null;
}

function toAssignmentView(
  state: TeamExecutionState,
  assignment: TeamExecutionState['delegate_assignments'][number],
): TeamAssignmentView {
  const session = currentSession(state, assignment);
  // The public view layer stays decoupled from DelegatedRuntimeHandleV1 and
  // recomputes stable identity/path refs from canonical run + assignment ids.
  const execution = buildDelegatedExecutionIdentity({
    project_run_id: state.run_id,
    assignment_id: assignment.assignment_id,
  });
  return {
    assignment_id: assignment.assignment_id,
    agent_id: assignment.delegate_id,
    stage: assignment.stage,
    status: assignment.status,
    workspace_id: state.workspace_id,
    task_id: assignment.task_id,
    task_kind: assignment.task_kind,
    handoff_id: assignment.handoff_id,
    handoff_kind: assignment.handoff_kind,
    checkpoint_id: assignment.checkpoint_id,
    timeout_at: assignment.timeout_at,
    last_heartbeat_at: assignment.last_heartbeat_at,
    manifest_path: delegatedExecutionManifestPath(execution),
    runtime_run_id: execution.runtime_run_id,
    session_id: assignment.session_id,
    session_parent_id: session?.parent_session_id ?? null,
    session_context_kind: session?.context_kind ?? null,
    forked_from_assignment_id: assignment.forked_from_assignment_id,
    forked_from_session_id: assignment.forked_from_session_id,
    last_completed_step: assignment.last_completed_step,
    resume_from: assignment.resume_from,
    approval_id: assignment.approval_id,
    approval_packet_path: assignment.approval_packet_path,
    approval_requested_at: assignment.approval_requested_at,
    delegation_protocol: assignment.delegation_protocol,
  };
}

function toBackgroundTaskView(
  state: TeamExecutionState,
  assignment: TeamExecutionState['delegate_assignments'][number],
): TeamBackgroundTaskView {
  const taskProjection = taskProjectionFromAssignmentStatus(assignment.status);
  const session = currentSession(state, assignment);
  // Background-task projection follows the same no-handle rule as the rest of
  // the public view surface.
  const execution = buildDelegatedExecutionIdentity({
    project_run_id: state.run_id,
    assignment_id: assignment.assignment_id,
  });
  return {
    assignment_id: assignment.assignment_id,
    agent_id: assignment.delegate_id,
    task_id: assignment.task_id,
    task_kind: assignment.task_kind,
    session_id: assignment.session_id,
    session_parent_id: session?.parent_session_id ?? null,
    session_context_kind: session?.context_kind ?? null,
    forked_from_assignment_id: assignment.forked_from_assignment_id,
    forked_from_session_id: assignment.forked_from_session_id,
    runtime_run_id: execution.runtime_run_id,
    runtime_status: assignment.status,
    task_lifecycle_status: taskProjection.task_lifecycle_status,
    task_status: taskProjection.task_status,
    checkpoint_id: assignment.checkpoint_id,
    last_completed_step: assignment.last_completed_step,
    resume_from: assignment.resume_from,
    approval_id: assignment.approval_id,
  };
}

export function buildTeamLiveStatusView(state: TeamExecutionState): TeamLiveStatusView {
  const activeIds = new Set(state.active_assignment_ids);
  const activeAssignments = state.delegate_assignments
    .filter(assignment => activeIds.has(assignment.assignment_id))
    .map(assignment => toAssignmentView(state, assignment));
  const terminalAssignments = state.delegate_assignments
    .filter(assignment => !activeIds.has(assignment.assignment_id))
    .map(assignment => toAssignmentView(state, assignment));
  return {
    run_id: state.run_id,
    workspace_id: state.workspace_id,
    coordination_policy: state.coordination_policy,
    blocked_stage: state.blocked_stage,
    active_assignment_ids: [...state.active_assignment_ids],
    active_assignments: activeAssignments,
    terminal_assignments: terminalAssignments,
    pending_approvals: derivePendingApprovals(state),
    background_tasks: state.delegate_assignments.map(assignment => toBackgroundTaskView(state, assignment)),
    updated_at: state.updated_at,
  };
}

export function buildTeamReplay(state: TeamExecutionState): TeamReplayEntry[] {
  return state.event_log.map(event => ({
    created_at: event.created_at,
    kind: event.kind,
    assignment_id: event.assignment_id,
    task_id: event.task_id,
    checkpoint_id: event.checkpoint_id,
    payload: { ...event.payload },
  }));
}

export function buildTeamControlPlaneView(state: TeamExecutionState): {
  live_status: TeamLiveStatusView;
  replay: TeamReplayEntry[];
} {
  return {
    live_status: buildTeamLiveStatusView(state),
    replay: buildTeamReplay(state),
  };
}
