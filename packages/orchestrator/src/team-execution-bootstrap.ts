import { randomUUID } from 'node:crypto';
import { utcNowIso } from './util.js';
import { appendTeamEvent } from './team-execution-events.js';
import { buildTeamDelegationProtocol } from './delegation-protocol.js';
import { clonePermissions } from './team-execution-clone.js';
import { assertDelegationAllowed } from './team-execution-permissions.js';
import type {
  TeamDelegateAssignment,
  TeamExecutionAssignmentInput,
  TeamExecutionInput,
  TeamExecutionState,
} from './team-execution-types.js';
import { applyTeamIntervention } from './team-execution-interventions.js';
import { activeAssignmentIds } from './team-execution-assignment-state.js';

export function createTeamExecutionState(input: TeamExecutionInput, runId: string): TeamExecutionState {
  assertDelegationAllowed(input.permissions, input.assignment);
  const timestamp = utcNowIso();
  const assignmentId = input.assignment.assignment_id ?? randomUUID();
  const assignment: TeamDelegateAssignment = {
    assignment_id: assignmentId,
    stage: input.assignment.stage ?? 0,
    delegation_protocol: input.assignment.delegation_protocol ?? buildTeamDelegationProtocol({
      assignment_id: assignmentId,
      workspace_id: input.workspace_id,
      task_id: input.assignment.task_id,
      task_kind: input.assignment.task_kind,
      owner_role: input.assignment.owner_role,
      delegate_role: input.assignment.delegate_role,
      delegate_id: input.assignment.delegate_id,
      coordination_policy: input.coordination_policy,
      stage: input.assignment.stage ?? 0,
      handoff_id: input.assignment.handoff_id ?? null,
      handoff_kind: input.assignment.handoff_kind ?? null,
      checkpoint_id: input.assignment.checkpoint_id ?? null,
      required_tools: [],
    }),
    owner_role: input.assignment.owner_role,
    delegate_role: input.assignment.delegate_role,
    delegate_id: input.assignment.delegate_id,
    task_id: input.assignment.task_id,
    task_kind: input.assignment.task_kind,
    handoff_id: input.assignment.handoff_id ?? null,
    handoff_kind: input.assignment.handoff_kind ?? null,
    checkpoint_id: input.assignment.checkpoint_id ?? null,
    status: 'pending',
    timeout_at: input.assignment.timeout_at ?? null,
    last_heartbeat_at: null,
    last_completed_step: null,
    resume_from: null,
    updated_at: timestamp,
  };
  const state: TeamExecutionState = {
    schema_version: 1,
    run_id: runId,
    workspace_id: input.workspace_id,
    coordination_policy: input.coordination_policy,
    permissions: clonePermissions(input.permissions),
    delegate_assignments: [assignment],
    active_assignment_ids: [assignment.assignment_id],
    checkpoints: [],
    interventions: [],
    blocked_stage: null,
    event_log: [],
    updated_at: timestamp,
  };
  appendTeamEvent(state, {
    kind: 'assignment_registered',
    assignment,
    payload: { stage: assignment.stage, status: assignment.status },
  });
  for (const command of input.interventions ?? []) {
    applyTeamIntervention(state, command);
  }
  return state;
}

export function registerDelegateAssignment(
  state: TeamExecutionState,
  assignmentInput: TeamExecutionAssignmentInput,
): TeamDelegateAssignment {
  assertDelegationAllowed(state.permissions, assignmentInput);
  const timestamp = utcNowIso();
  const assignmentId = assignmentInput.assignment_id ?? randomUUID();
  const assignment: TeamDelegateAssignment = {
    assignment_id: assignmentId,
    stage: assignmentInput.stage ?? 0,
    delegation_protocol: assignmentInput.delegation_protocol ?? buildTeamDelegationProtocol({
      assignment_id: assignmentId,
      workspace_id: state.workspace_id,
      task_id: assignmentInput.task_id,
      task_kind: assignmentInput.task_kind,
      owner_role: assignmentInput.owner_role,
      delegate_role: assignmentInput.delegate_role,
      delegate_id: assignmentInput.delegate_id,
      coordination_policy: state.coordination_policy,
      stage: assignmentInput.stage ?? 0,
      handoff_id: assignmentInput.handoff_id ?? null,
      handoff_kind: assignmentInput.handoff_kind ?? null,
      checkpoint_id: assignmentInput.checkpoint_id ?? null,
      required_tools: [],
    }),
    owner_role: assignmentInput.owner_role,
    delegate_role: assignmentInput.delegate_role,
    delegate_id: assignmentInput.delegate_id,
    task_id: assignmentInput.task_id,
    task_kind: assignmentInput.task_kind,
    handoff_id: assignmentInput.handoff_id ?? null,
    handoff_kind: assignmentInput.handoff_kind ?? null,
    checkpoint_id: assignmentInput.checkpoint_id ?? null,
    status: 'pending',
    timeout_at: assignmentInput.timeout_at ?? null,
    last_heartbeat_at: null,
    last_completed_step: null,
    resume_from: null,
    updated_at: timestamp,
  };
  state.delegate_assignments.push(assignment);
  state.active_assignment_ids = activeAssignmentIds(state.delegate_assignments);
  state.updated_at = timestamp;
  appendTeamEvent(state, {
    kind: 'assignment_registered',
    assignment,
    payload: { stage: assignment.stage, status: assignment.status },
  });
  return assignment;
}
