import { randomUUID } from 'node:crypto';
import { utcNowIso } from './util.js';
import {
  appendRegisteredAssignment,
  buildTeamDelegateAssignment,
  findMatchingAssignment,
} from './team-execution-assignment-builder.js';
import { appendTeamEvent } from './team-execution-events.js';
import {
  buildInjectedAssignmentInput,
  buildPendingRedirect,
} from './team-execution-intervention-payloads.js';
import { assertInterventionAllowed } from './team-execution-permissions.js';
import {
  applyAssignmentUpdate,
  isTerminalAssignmentStatus,
  updateStateTimestamp,
} from './team-execution-assignment-state.js';
import { finalizeAssignmentSession, syncPendingApprovals } from './team-execution-scoping.js';
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
  approval_id?: string | null;
  approval_packet_path?: string | null;
  approval_requested_at?: string | null;
  pending_redirect?: TeamExecutionState['delegate_assignments'][number]['pending_redirect'];
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
  if (command === 'approve') {
    return {
      status: 'pending',
      paused_from_status: null,
      approval_id: null,
      approval_packet_path: null,
      approval_requested_at: null,
    };
  }
  if (command === 'cancel') {
    return {
      status: 'cancelled',
      paused_from_status: null,
      pending_redirect: null,
      approval_id: null,
      approval_packet_path: null,
      approval_requested_at: null,
    };
  }
  return {
    status: 'cascade_stopped',
    paused_from_status: null,
    pending_redirect: null,
    approval_id: null,
    approval_packet_path: null,
    approval_requested_at: null,
  };
}

function assertInterventionImplemented(command: TeamInterventionCommand): void {
  if (command.scope === 'project') {
    throw new Error('team runtime does not implement project-scoped interventions');
  }
  if (['approve', 'redirect', 'inject_task'].includes(command.kind) && command.scope !== 'task') {
    throw new Error(`team runtime only implements task-scoped '${command.kind}' interventions`);
  }
}

function resolveAffectedAssignments(
  state: TeamExecutionState,
  command: TeamInterventionCommand,
): TeamDelegateAssignment[] {
  if (command.kind === 'cascade_stop' || command.scope === 'team') {
    return state.delegate_assignments.filter(assignment => !isTerminalAssignmentStatus(assignment.status));
  }
  const assignment = resolveTargetAssignment(state, command);
  if (!assignment) {
    throw new Error('unknown team assignment for intervention target');
  }
  return [assignment];
}

function buildRecord(command: TeamInterventionCommand, timestamp: string): TeamInterventionRecord {
  return {
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
}

export function applyTeamIntervention(
  state: TeamExecutionState,
  command: TeamInterventionCommand,
): TeamInterventionRecord {
  assertInterventionAllowed(state.permissions, command);
  assertInterventionImplemented(command);
  const timestamp = utcNowIso();

  if (command.kind === 'redirect') {
    const assignment = resolveTargetAssignment(state, command);
    if (!assignment) throw new Error('unknown team assignment for intervention target');
    if (isTerminalAssignmentStatus(assignment.status)) {
      throw new Error('cannot redirect a terminal team assignment');
    }
    const pending = buildPendingRedirect(command, timestamp);
    const record = buildRecord(command, timestamp);
    state.interventions.push(record);
    applyAssignmentUpdate(assignment, { pending_redirect: pending }, timestamp);
    appendTeamEvent(state, {
      kind: 'intervention_applied',
      assignment,
      checkpoint_id: command.checkpoint_id ?? null,
      payload: {
        actor_role: command.actor_role,
        actor_id: command.actor_id ?? null,
        scope: command.scope,
        kind: command.kind,
        note: command.note ?? null,
        target_assignment_id: assignment.assignment_id,
        target_assignment_ids: [assignment.assignment_id],
        task_id: assignment.task_id,
      },
    });
    updateStateTimestamp(state, timestamp);
    syncPendingApprovals(state, state.run_id);
    return record;
  }

  if (command.kind === 'inject_task') {
    const source = resolveTargetAssignment(state, command);
    if (!source) throw new Error('unknown team assignment for intervention target');
    if (isTerminalAssignmentStatus(source.status)) {
      throw new Error('cannot inject a follow-on task from a terminal team assignment');
    }
    const assignmentInput = {
      ...buildInjectedAssignmentInput(source, command),
      forked_from_assignment_id: source.assignment_id,
      forked_from_session_id: source.session_id,
      mcp_tool_inheritance: {
        mode: 'inherit_from_assignment',
        inherit_from_assignment_id: source.assignment_id,
      } as const,
    };
    const existing = findMatchingAssignment(state.delegate_assignments, assignmentInput);
    const injected = existing ?? appendRegisteredAssignment(
      state,
      buildTeamDelegateAssignment(
        state,
        assignmentInput,
        source.delegation_protocol.REQUIRED_TOOLS.tool_names,
        timestamp,
      ),
    );
    const record = buildRecord(command, timestamp);
    state.interventions.push(record);
    appendTeamEvent(state, {
      kind: 'intervention_applied',
      assignment: source,
      checkpoint_id: command.checkpoint_id ?? null,
      payload: {
        actor_role: command.actor_role,
        actor_id: command.actor_id ?? null,
        scope: command.scope,
        kind: command.kind,
        note: command.note ?? null,
        target_assignment_id: source.assignment_id,
        target_assignment_ids: [source.assignment_id],
        task_id: source.task_id,
        injected_assignment_id: injected.assignment_id,
        injected_task_id: injected.task_id,
      },
    });
    updateStateTimestamp(state, timestamp);
    syncPendingApprovals(state, state.run_id);
    return record;
  }

  const affectedAssignments = resolveAffectedAssignments(state, command);
  if (command.kind === 'approve') {
    const [assignment] = affectedAssignments;
    if (!assignment) throw new Error('unknown team assignment for intervention target');
    if (assignment.status !== 'awaiting_approval') {
      throw new Error("approve intervention requires assignment status 'awaiting_approval'");
    }
    if (!assignment.approval_id || !assignment.approval_packet_path || !assignment.approval_requested_at) {
      throw new Error('approve intervention requires persisted approval metadata');
    }
    const approval = state.pending_approvals.find(item =>
      item.approval_id === assignment.approval_id
      && item.assignment_id === assignment.assignment_id
      && item.agent_id === assignment.delegate_id,
    );
    if (!approval) {
      throw new Error('approve intervention requires persisted delegated approval ownership');
    }
  }
  const record = buildRecord(command, timestamp);
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
    if (isTerminalAssignmentStatus(assignment.status)) {
      finalizeAssignmentSession(state, assignment, timestamp);
    }
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
  syncPendingApprovals(state, state.run_id);
  return record;
}
