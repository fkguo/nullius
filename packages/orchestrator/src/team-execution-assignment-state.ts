import { utcNowIso } from './util.js';
import { appendTeamEvent } from './team-execution-events.js';
import type {
  TeamCheckpointBinding,
  TeamDelegateAssignment,
  TeamExecutionState,
} from './team-execution-types.js';

const ACTIVE_ASSIGNMENT_STATUSES = ['pending', 'running', 'paused', 'awaiting_approval', 'needs_recovery'] as const;
const TERMINAL_ASSIGNMENT_STATUSES = ['completed', 'failed', 'cancelled', 'timed_out', 'cascade_stopped'] as const;

type ActiveAssignmentStatus = (typeof ACTIVE_ASSIGNMENT_STATUSES)[number];
type TerminalAssignmentStatus = (typeof TERMINAL_ASSIGNMENT_STATUSES)[number];

export function isActiveAssignmentStatus(
  status: TeamDelegateAssignment['status'],
): status is ActiveAssignmentStatus {
  return ACTIVE_ASSIGNMENT_STATUSES.includes(status as ActiveAssignmentStatus);
}

export function isTerminalAssignmentStatus(
  status: TeamDelegateAssignment['status'],
): status is TerminalAssignmentStatus {
  return TERMINAL_ASSIGNMENT_STATUSES.includes(status as TerminalAssignmentStatus);
}

export function activeAssignmentIds(assignments: TeamDelegateAssignment[]): string[] {
  return assignments
    .filter(assignment => isActiveAssignmentStatus(assignment.status))
    .map(assignment => assignment.assignment_id);
}

export function updateStateTimestamp(state: TeamExecutionState, timestamp: string): void {
  state.active_assignment_ids = activeAssignmentIds(state.delegate_assignments);
  state.updated_at = timestamp;
}

export function applyAssignmentUpdate(
  assignment: TeamDelegateAssignment,
  update: {
    approval_id?: string | null;
    approval_packet_path?: string | null;
    approval_requested_at?: string | null;
    checkpoint_id?: string | null;
    last_completed_step?: string | null;
    last_heartbeat_at?: string | null;
    pending_redirect?: TeamDelegateAssignment['pending_redirect'];
    paused_from_status?: TeamDelegateAssignment['paused_from_status'];
    resume_from?: string | null;
    status?: TeamDelegateAssignment['status'];
    timeout_at?: string | null;
  },
  timestamp: string,
): void {
  if (update.status !== undefined) assignment.status = update.status;
  if (update.approval_id !== undefined) assignment.approval_id = update.approval_id;
  if (update.approval_packet_path !== undefined) assignment.approval_packet_path = update.approval_packet_path;
  if (update.approval_requested_at !== undefined) assignment.approval_requested_at = update.approval_requested_at;
  if (update.checkpoint_id !== undefined) assignment.checkpoint_id = update.checkpoint_id;
  if (update.timeout_at !== undefined) assignment.timeout_at = update.timeout_at;
  if (update.status !== undefined && update.status !== 'paused' && update.paused_from_status === undefined) {
    assignment.paused_from_status = null;
  }
  if (update.paused_from_status !== undefined) assignment.paused_from_status = update.paused_from_status;
  if (update.pending_redirect !== undefined) assignment.pending_redirect = update.pending_redirect;
  if (update.last_completed_step !== undefined) assignment.last_completed_step = update.last_completed_step;
  if (update.resume_from !== undefined) assignment.resume_from = update.resume_from;
  if (update.last_heartbeat_at !== undefined) assignment.last_heartbeat_at = update.last_heartbeat_at;
  assignment.updated_at = timestamp;
}

export function updateDelegateAssignment(
  state: TeamExecutionState,
  assignmentId: string,
  update: {
    approval_id?: string | null;
    approval_packet_path?: string | null;
    approval_requested_at?: string | null;
    status?: TeamDelegateAssignment['status'];
    checkpoint_id?: string | null;
    timeout_at?: string | null;
    paused_from_status?: TeamDelegateAssignment['paused_from_status'];
    pending_redirect?: TeamDelegateAssignment['pending_redirect'];
    last_completed_step?: string | null;
    resume_from?: string | null;
    last_heartbeat_at?: string | null;
  },
): TeamDelegateAssignment {
  const assignment = state.delegate_assignments.find(item => item.assignment_id === assignmentId);
  if (!assignment) {
    throw new Error(`unknown team assignment: ${assignmentId}`);
  }
  const timestamp = utcNowIso();
  applyAssignmentUpdate(assignment, update, timestamp);
  updateStateTimestamp(state, timestamp);
  return assignment;
}

export function recordTeamCheckpoint(
  state: TeamExecutionState,
  checkpoint: {
    assignment_id: string;
    checkpoint_id: string;
    task_id: string;
    handoff_id?: string | null;
    last_completed_step?: string | null;
    resume_from?: string | null;
  },
): TeamCheckpointBinding {
  const assignment = state.delegate_assignments.find(item => item.assignment_id === checkpoint.assignment_id);
  if (!assignment) {
    throw new Error(`unknown team assignment: ${checkpoint.assignment_id}`);
  }
  const timestamp = utcNowIso();
  const binding: TeamCheckpointBinding = {
    checkpoint_id: checkpoint.checkpoint_id,
    assignment_id: checkpoint.assignment_id,
    task_id: checkpoint.task_id,
    handoff_id: checkpoint.handoff_id ?? assignment.handoff_id,
    last_completed_step: checkpoint.last_completed_step ?? null,
    resume_from: checkpoint.resume_from ?? null,
    updated_at: timestamp,
  };
  const existing = state.checkpoints.findIndex(item => item.checkpoint_id === binding.checkpoint_id);
  if (existing >= 0) {
    state.checkpoints[existing] = binding;
  } else {
    state.checkpoints.push(binding);
  }
  applyAssignmentUpdate(
    assignment,
    {
      checkpoint_id: binding.checkpoint_id,
      last_completed_step: binding.last_completed_step,
      resume_from: binding.resume_from,
    },
    timestamp,
  );
  updateStateTimestamp(state, timestamp);
  appendTeamEvent(state, {
    kind: 'checkpoint_recorded',
    assignment,
    checkpoint_id: binding.checkpoint_id,
    payload: {
      last_completed_step: binding.last_completed_step,
      resume_from: binding.resume_from,
    },
  });
  return binding;
}

export function restoreTeamCheckpoint(
  state: TeamExecutionState,
  checkpointId: string,
): TeamCheckpointBinding {
  const binding = state.checkpoints.find(item => item.checkpoint_id === checkpointId);
  if (!binding) {
    throw new Error(`unknown team checkpoint: ${checkpointId}`);
  }
  const assignment = state.delegate_assignments.find(item => item.assignment_id === binding.assignment_id);
  if (!assignment) {
    throw new Error(`checkpoint ${checkpointId} references missing assignment ${binding.assignment_id}`);
  }
  const timestamp = utcNowIso();
  applyAssignmentUpdate(
    assignment,
    {
      checkpoint_id: binding.checkpoint_id,
      last_completed_step: binding.last_completed_step,
      resume_from: binding.resume_from,
      status: 'needs_recovery',
    },
    timestamp,
  );
  updateStateTimestamp(state, timestamp);
  appendTeamEvent(state, {
    kind: 'checkpoint_restored',
    assignment,
    checkpoint_id: binding.checkpoint_id,
    payload: {
      last_completed_step: binding.last_completed_step,
      resume_from: binding.resume_from,
    },
  });
  return binding;
}

export function recordHeartbeat(
  state: TeamExecutionState,
  assignmentId: string,
  at: string = utcNowIso(),
): TeamDelegateAssignment {
  return updateDelegateAssignment(state, assignmentId, { last_heartbeat_at: at });
}

export function markTimedOutAssignments(
  state: TeamExecutionState,
  now: string = utcNowIso(),
): TeamDelegateAssignment[] {
  const nowMs = new Date(now).getTime();
  const timedOut: TeamDelegateAssignment[] = [];
  for (const assignment of state.delegate_assignments) {
    if (!assignment.timeout_at || !isActiveAssignmentStatus(assignment.status)) continue;
    const timeoutMs = new Date(assignment.timeout_at).getTime();
    if (Number.isNaN(timeoutMs) || timeoutMs > nowMs) continue;
    applyAssignmentUpdate(
      assignment,
      {
        status: 'timed_out',
        pending_redirect: null,
        approval_id: null,
        approval_packet_path: null,
        approval_requested_at: null,
      },
      now,
    );
    assignment.paused_from_status = null;
    timedOut.push(assignment);
    appendTeamEvent(state, {
      kind: 'assignment_timed_out',
      assignment,
      payload: { timeout_at: assignment.timeout_at },
    });
  }
  if (timedOut.length > 0) {
    updateStateTimestamp(state, now);
  }
  return timedOut;
}
