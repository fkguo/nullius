import { shortId } from '@nullius/shared';
import { StateManager } from './state-manager.js';
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
import { finalizeAssignmentSession } from './team-execution-scoping.js';
import type {
  TeamDelegateAssignment,
  TeamExecutionState,
  TeamInterventionCommand,
  TeamInterventionRecord,
} from './team-execution-types.js';

export interface TeamInterventionAuthorityContext {
  projectRoot: string;
}

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
  pending_approval?: TeamExecutionState['delegate_assignments'][number]['pending_approval'];
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
    const status = assignment.status === 'paused'
      ? (assignment.paused_from_status ?? 'running')
      : assignment.status === 'awaiting_approval' && assignment.pending_approval?.authority === 'run_gate'
        ? 'pending'
        : assignment.status;
    return {
      status,
      paused_from_status: null,
    };
  }
  if (command === 'approve') {
    return {
      status: 'pending',
      paused_from_status: null,
      pending_approval: null,
    };
  }
  if (command === 'cancel') {
    return {
      status: 'cancelled',
      paused_from_status: null,
      pending_redirect: null,
      pending_approval: null,
    };
  }
  return {
    status: 'cascade_stopped',
    paused_from_status: null,
    pending_redirect: null,
    pending_approval: null,
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
    intervention_id: shortId(),
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

function assertCanonicalRunGateSatisfied(
  state: TeamExecutionState,
  assignments: TeamDelegateAssignment[],
  authorityContext: TeamInterventionAuthorityContext | undefined,
): void {
  const runGateAssignments = assignments.filter(assignment =>
    assignment.status === 'awaiting_approval'
    && assignment.pending_approval?.authority === 'run_gate',
  );
  if (runGateAssignments.length === 0) return;
  if (!authorityContext) {
    throw new Error(
      'resume intervention cannot release run-gate authority without the canonical root-run state',
    );
  }
  const rootState = new StateManager(authorityContext.projectRoot).readState();
  for (const assignment of runGateAssignments) {
    const pending = assignment.pending_approval;
    if (!pending || pending.authority !== 'run_gate') continue;
    const historyConfirmsApproval = rootState.approval_history.some(entry =>
      entry.decision === 'approved'
      && entry.category === pending.gate_id
      && entry.approval_id === pending.approval_id,
    );
    if (state.run_id !== pending.run_id
      || rootState.run_id !== pending.run_id
      || rootState.pending_approval !== null
      || rootState.gate_satisfied[pending.gate_id] !== pending.approval_id
      || !historyConfirmsApproval) {
      throw new Error(
        `resume intervention cannot release run-gate authority: canonical approval ${pending.approval_id} for ${pending.gate_id} is not satisfied`,
      );
    }
  }
}

export function applyTeamIntervention(
  state: TeamExecutionState,
  command: TeamInterventionCommand,
  authorityContext?: TeamInterventionAuthorityContext,
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
    return record;
  }

  const affectedAssignments = resolveAffectedAssignments(state, command);
  if (command.kind === 'resume') {
    // Team state is a projection, not root approval authority. Re-dispatch is
    // allowed only after the canonical root handler has durably approved the
    // exact run/gate/approval tuple.
    assertCanonicalRunGateSatisfied(state, affectedAssignments, authorityContext);
  }
  if (command.kind === 'approve') {
    const [assignment] = affectedAssignments;
    if (!assignment) throw new Error('unknown team assignment for intervention target');
    if (assignment.status !== 'awaiting_approval') {
      throw new Error("approve intervention requires assignment status 'awaiting_approval'");
    }
    if (!assignment.delegate_id) {
      throw new Error('approve intervention requires delegated approval ownership metadata');
    }
    // Approval authority lives on the tagged assignment reference. A run gate
    // can only be resolved through the canonical root-run approval surface;
    // team-local intervention metadata is not an approval grant.
    if (!assignment.pending_approval) {
      throw new Error('approve intervention requires canonical assignment approval metadata');
    }
    if (assignment.pending_approval.authority === 'run_gate') {
      throw new Error(
        'approve intervention cannot resolve run-gate authority; use canonical orch_run_approve/nullius approve, then resume the assignment',
      );
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
  return record;
}
