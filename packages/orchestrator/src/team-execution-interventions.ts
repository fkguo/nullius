import { randomUUID } from 'node:crypto';
import { utcNowIso } from './util.js';
import { appendTeamEvent } from './team-execution-events.js';
import { assertInterventionAllowed } from './team-execution-permissions.js';
import {
  applyAssignmentUpdate,
  isTerminalAssignmentStatus,
  updateStateTimestamp,
} from './team-execution-assignment-state.js';
import type {
  TeamDelegateAssignment,
  TeamExecutionState,
  TeamInterventionCommand,
  TeamInterventionRecord,
} from './team-execution-types.js';

function resolveTargetAssignment(
  state: TeamExecutionState,
  command: TeamInterventionCommand,
): TeamDelegateAssignment | null {
  if (command.target_assignment_id) {
    return state.delegate_assignments.find(item => item.assignment_id === command.target_assignment_id) ?? null;
  }
  if (command.task_id) {
    return state.delegate_assignments.find(item => item.task_id === command.task_id) ?? null;
  }
  if (command.checkpoint_id) {
    const checkpoint = state.checkpoints.find(item => item.checkpoint_id === command.checkpoint_id);
    if (!checkpoint) return null;
    return state.delegate_assignments.find(item => item.assignment_id === checkpoint.assignment_id) ?? null;
  }
  return null;
}

function nextAssignmentUpdate(
  assignment: TeamExecutionState['delegate_assignments'][number],
  command: TeamInterventionCommand['kind'],
): {
  status: TeamExecutionState['delegate_assignments'][number]['status'];
  paused_from_status?: TeamExecutionState['delegate_assignments'][number]['paused_from_status'];
} {
  if (command === 'pause') {
    return {
      status: 'paused',
      paused_from_status: assignment.status === 'paused'
        ? assignment.paused_from_status
        : assignment.status,
    };
  }
  if (command === 'resume') {
    return {
      status: assignment.status === 'paused'
        ? (assignment.paused_from_status ?? 'running')
        : assignment.status,
      paused_from_status: null,
    };
  }
  if (command === 'cancel') return { status: 'cancelled', paused_from_status: null };
  return { status: 'cascade_stopped', paused_from_status: null };
}

function assertInterventionImplemented(command: TeamInterventionCommand): void {
  if (!['pause', 'resume', 'cancel', 'cascade_stop'].includes(command.kind)) {
    throw new Error(`team runtime does not implement intervention kind '${command.kind}'`);
  }
  if (command.scope === 'project') {
    throw new Error('team runtime does not implement project-scoped interventions');
  }
}

function resolveAffectedAssignments(
  state: TeamExecutionState,
  command: TeamInterventionCommand,
): TeamDelegateAssignment[] {
  assertInterventionImplemented(command);
  if (command.kind === 'cascade_stop' || command.scope === 'team') {
    return state.delegate_assignments.filter(assignment => !isTerminalAssignmentStatus(assignment.status));
  }
  const assignment = resolveTargetAssignment(state, command);
  if (!assignment) {
    throw new Error('unknown team assignment for intervention target');
  }
  return [assignment];
}

export function applyTeamIntervention(
  state: TeamExecutionState,
  command: TeamInterventionCommand,
): TeamInterventionRecord {
  assertInterventionAllowed(state.permissions, command);
  const affectedAssignments = resolveAffectedAssignments(state, command);
  const timestamp = utcNowIso();
  const record: TeamInterventionRecord = {
    intervention_id: randomUUID(),
    kind: command.kind,
    scope: command.scope,
    actor_role: command.actor_role,
    actor_id: command.actor_id ?? null,
    target_assignment_id: command.target_assignment_id ?? null,
    task_id: command.task_id ?? null,
    checkpoint_id: command.checkpoint_id ?? null,
    note: command.note ?? null,
    created_at: timestamp,
    payload: { ...(command.payload ?? {}) },
  };
  state.interventions.push(record);
  appendTeamEvent(state, {
    kind: 'intervention_applied',
    assignment: affectedAssignments.length === 1 ? affectedAssignments[0] : null,
    checkpoint_id: command.checkpoint_id ?? null,
    payload: {
      actor_role: command.actor_role,
      actor_id: command.actor_id ?? null,
      scope: command.scope,
      kind: command.kind,
      note: command.note ?? null,
      target_assignment_id: command.target_assignment_id ?? null,
      target_assignment_ids: affectedAssignments.map(item => item.assignment_id),
      task_id: command.task_id ?? null,
    },
  });

  for (const assignment of affectedAssignments) {
    const update = nextAssignmentUpdate(assignment, command.kind);
    applyAssignmentUpdate(
      assignment,
      update,
      timestamp,
    );
    appendTeamEvent(state, {
      kind: 'assignment_status_changed',
      assignment,
      payload: {
        stage: assignment.stage,
        status: assignment.status,
        reason: 'intervention',
        intervention_kind: command.kind,
        scope: command.scope,
      },
    });
  }
  updateStateTimestamp(state, timestamp);
  return record;
}
