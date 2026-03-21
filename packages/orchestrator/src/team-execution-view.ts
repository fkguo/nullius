import type { TeamDelegationProtocol } from './delegation-protocol.js';
import type {
  TeamAssignmentStatus,
  TeamCoordinationPolicy,
  TeamExecutionEvent,
  TeamExecutionState,
} from './team-execution-types.js';

function manifestPath(runId: string, assignmentId: string): string {
  return `artifacts/runs/${runId}__${assignmentId}/manifest.json`;
}

export interface TeamAssignmentView {
  assignment_id: string;
  stage: number;
  status: TeamAssignmentStatus;
  workspace_id: string;
  task_id: string;
  task_kind: TeamExecutionState['delegate_assignments'][number]['task_kind'];
  handoff_id: string | null;
  handoff_kind: TeamExecutionState['delegate_assignments'][number]['handoff_kind'];
  checkpoint_id: string | null;
  manifest_path: string;
  last_completed_step: string | null;
  resume_from: string | null;
  delegation_protocol: TeamDelegationProtocol;
}

export interface TeamLiveStatusView {
  run_id: string;
  workspace_id: string;
  coordination_policy: TeamCoordinationPolicy;
  blocked_stage: number | null;
  active_assignment_ids: string[];
  active_assignments: TeamAssignmentView[];
  terminal_assignments: TeamAssignmentView[];
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

function toAssignmentView(
  state: TeamExecutionState,
  assignment: TeamExecutionState['delegate_assignments'][number],
): TeamAssignmentView {
  return {
    assignment_id: assignment.assignment_id,
    stage: assignment.stage,
    status: assignment.status,
    workspace_id: state.workspace_id,
    task_id: assignment.task_id,
    task_kind: assignment.task_kind,
    handoff_id: assignment.handoff_id,
    handoff_kind: assignment.handoff_kind,
    checkpoint_id: assignment.checkpoint_id,
    manifest_path: manifestPath(state.run_id, assignment.assignment_id),
    last_completed_step: assignment.last_completed_step,
    resume_from: assignment.resume_from,
    delegation_protocol: assignment.delegation_protocol,
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
