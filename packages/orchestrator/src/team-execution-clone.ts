import type {
  TeamCheckpointBinding,
  TeamDelegateAssignment,
  TeamExecutionEvent,
  TeamExecutionState,
  TeamInterventionRecord,
  TeamPendingRedirect,
  TeamPermissionMatrix,
} from './team-execution-types.js';

export function clonePermissions(permissions: TeamPermissionMatrix): TeamPermissionMatrix {
  return {
    delegation: permissions.delegation.map(entry => ({
      from_role: entry.from_role,
      to_role: entry.to_role,
      allowed_task_kinds: [...entry.allowed_task_kinds],
      allowed_handoff_kinds: [...entry.allowed_handoff_kinds],
      ...(entry.allowed_tool_names !== undefined ? { allowed_tool_names: [...entry.allowed_tool_names] } : {}),
    })),
    interventions: permissions.interventions.map(entry => ({
      actor_role: entry.actor_role,
      allowed_scopes: [...entry.allowed_scopes],
      allowed_kinds: [...entry.allowed_kinds],
    })),
  };
}

function cloneAssignment(assignment: TeamDelegateAssignment): TeamDelegateAssignment {
  return {
    assignment_id: assignment.assignment_id,
    owner_role: assignment.owner_role,
    delegate_role: assignment.delegate_role,
    delegate_id: assignment.delegate_id,
    task_id: assignment.task_id,
    task_kind: assignment.task_kind,
    handoff_id: assignment.handoff_id,
    handoff_kind: assignment.handoff_kind,
    checkpoint_id: assignment.checkpoint_id,
    stage: assignment.stage,
    delegation_protocol: {
      TASK: { ...assignment.delegation_protocol.TASK },
      EXPECTED_OUTCOME: { ...assignment.delegation_protocol.EXPECTED_OUTCOME },
      REQUIRED_TOOLS: { tool_names: [...assignment.delegation_protocol.REQUIRED_TOOLS.tool_names] },
      MUST_DO: { items: [...assignment.delegation_protocol.MUST_DO.items] },
      MUST_NOT_DO: { items: [...assignment.delegation_protocol.MUST_NOT_DO.items] },
      CONTEXT: { ...assignment.delegation_protocol.CONTEXT },
    },
    status: assignment.status,
    timeout_at: assignment.timeout_at,
    paused_from_status: assignment.paused_from_status,
    session_id: assignment.session_id,
    last_heartbeat_at: assignment.last_heartbeat_at,
    last_completed_step: assignment.last_completed_step,
    resume_from: assignment.resume_from,
    approval_id: assignment.approval_id,
    approval_packet_path: assignment.approval_packet_path,
    approval_requested_at: assignment.approval_requested_at,
    pending_redirect: clonePendingRedirect(assignment.pending_redirect),
    updated_at: assignment.updated_at,
  };
}

function clonePendingRedirect(pending: TeamPendingRedirect | null): TeamPendingRedirect | null {
  if (!pending) return null;
  return {
    note: pending.note,
    payload: structuredClone(pending.payload),
    created_at: pending.created_at,
  };
}

function cloneCheckpoint(checkpoint: TeamCheckpointBinding): TeamCheckpointBinding {
  return {
    checkpoint_id: checkpoint.checkpoint_id,
    assignment_id: checkpoint.assignment_id,
    task_id: checkpoint.task_id,
    handoff_id: checkpoint.handoff_id,
    last_completed_step: checkpoint.last_completed_step,
    resume_from: checkpoint.resume_from,
    updated_at: checkpoint.updated_at,
  };
}

function cloneIntervention(intervention: TeamInterventionRecord): TeamInterventionRecord {
  return {
    intervention_id: intervention.intervention_id,
    kind: intervention.kind,
    scope: intervention.scope,
    actor_role: intervention.actor_role,
    actor_id: intervention.actor_id,
    target_assignment_id: intervention.target_assignment_id,
    task_id: intervention.task_id,
    checkpoint_id: intervention.checkpoint_id,
    note: intervention.note,
    created_at: intervention.created_at,
    payload: { ...intervention.payload },
  };
}

function cloneEvent(event: TeamExecutionEvent): TeamExecutionEvent {
  return {
    event_id: event.event_id,
    kind: event.kind,
    created_at: event.created_at,
    assignment_id: event.assignment_id,
    task_id: event.task_id,
    checkpoint_id: event.checkpoint_id,
    payload: { ...event.payload },
  };
}

export function cloneTeamExecutionState(state: TeamExecutionState): TeamExecutionState {
  return {
    schema_version: 1,
    run_id: state.run_id,
    workspace_id: state.workspace_id,
    coordination_policy: state.coordination_policy,
    permissions: clonePermissions(state.permissions),
    delegate_assignments: state.delegate_assignments.map(cloneAssignment),
    pending_approvals: (state.pending_approvals ?? []).map(entry => ({ ...entry })),
    sessions: (state.sessions ?? []).map(entry => ({ ...entry })),
    active_assignment_ids: [...state.active_assignment_ids],
    checkpoints: state.checkpoints.map(cloneCheckpoint),
    interventions: state.interventions.map(cloneIntervention),
    blocked_stage: state.blocked_stage,
    event_log: state.event_log.map(cloneEvent),
    updated_at: state.updated_at,
  };
}
