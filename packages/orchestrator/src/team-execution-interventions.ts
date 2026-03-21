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
  TeamExecutionState,
  TeamInterventionCommand,
  TeamInterventionRecord,
} from './team-execution-types.js';

function resolveTargetAssignment(
  state: TeamExecutionState,
  command: TeamInterventionCommand,
) {
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

function nextAssignmentStatus(
  current: TeamExecutionState['delegate_assignments'][number]['status'],
  command: TeamInterventionCommand['kind'],
): TeamExecutionState['delegate_assignments'][number]['status'] {
  if (command === 'pause') return 'paused';
  if (command === 'resume') return current === 'awaiting_approval' ? 'awaiting_approval' : 'running';
  if (command === 'cancel') return 'cancelled';
  if (command === 'cascade_stop') return 'cascade_stopped';
  return current;
}

export function applyTeamIntervention(
  state: TeamExecutionState,
  command: TeamInterventionCommand,
): TeamInterventionRecord {
  assertInterventionAllowed(state.permissions, command);
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
    assignment: command.kind === 'cascade_stop' ? null : resolveTargetAssignment(state, command),
    checkpoint_id: command.checkpoint_id ?? null,
    payload: {
      actor_role: command.actor_role,
      actor_id: command.actor_id ?? null,
      scope: command.scope,
      kind: command.kind,
      note: command.note ?? null,
      target_assignment_id: command.target_assignment_id ?? null,
      task_id: command.task_id ?? null,
    },
  });
  if (command.kind === 'cascade_stop') {
    for (const assignment of state.delegate_assignments) {
      if (isTerminalAssignmentStatus(assignment.status)) continue;
      applyAssignmentUpdate(assignment, { status: 'cascade_stopped' }, timestamp);
    }
  } else {
    const assignment = resolveTargetAssignment(state, command);
    if (!assignment) {
      throw new Error('unknown team assignment for intervention target');
    }
    applyAssignmentUpdate(
      assignment,
      { status: nextAssignmentStatus(assignment.status, command.kind) },
      timestamp,
    );
  }
  updateStateTimestamp(state, timestamp);
  return record;
}
