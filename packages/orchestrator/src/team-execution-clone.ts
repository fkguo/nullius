import type {
  TeamCheckpointBinding,
  TeamDelegateAssignment,
  TeamExecutionState,
  TeamInterventionRecord,
  TeamPermissionMatrix,
} from './team-execution-types.js';

export function clonePermissions(permissions: TeamPermissionMatrix): TeamPermissionMatrix {
  return {
    delegation: permissions.delegation.map(entry => ({
      from_role: entry.from_role,
      to_role: entry.to_role,
      allowed_task_kinds: [...entry.allowed_task_kinds],
      allowed_handoff_kinds: [...entry.allowed_handoff_kinds],
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
    status: assignment.status,
    timeout_at: assignment.timeout_at,
    last_heartbeat_at: assignment.last_heartbeat_at,
    last_completed_step: assignment.last_completed_step,
    resume_from: assignment.resume_from,
    updated_at: assignment.updated_at,
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

export function cloneTeamExecutionState(state: TeamExecutionState): TeamExecutionState {
  return {
    schema_version: 1,
    run_id: state.run_id,
    workspace_id: state.workspace_id,
    coordination_policy: state.coordination_policy,
    permissions: clonePermissions(state.permissions),
    delegate_assignments: state.delegate_assignments.map(cloneAssignment),
    active_assignment_ids: [...state.active_assignment_ids],
    checkpoints: state.checkpoints.map(cloneCheckpoint),
    interventions: state.interventions.map(cloneIntervention),
    updated_at: state.updated_at,
  };
}
