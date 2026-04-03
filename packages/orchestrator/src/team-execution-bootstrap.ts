import { utcNowIso } from './util.js';
import { clonePermissions } from './team-execution-clone.js';
import { assertDelegationAllowed } from './team-execution-permissions.js';
import {
  appendRegisteredAssignment,
  buildTeamDelegateAssignment,
} from './team-execution-assignment-builder.js';
import type {
  TeamDelegateAssignment,
  TeamExecutionAssignmentInput,
  TeamExecutionInput,
  TeamExecutionState,
} from './team-execution-types.js';
import { applyTeamIntervention } from './team-execution-interventions.js';

export function createTeamExecutionState(input: TeamExecutionInput, runId: string): TeamExecutionState {
  assertDelegationAllowed(input.permissions, input.assignment);
  const timestamp = utcNowIso();
  const state: TeamExecutionState = {
    schema_version: 1,
    run_id: runId,
    workspace_id: input.workspace_id,
    coordination_policy: input.coordination_policy,
    permissions: clonePermissions(input.permissions),
    delegate_assignments: [],
    pending_approvals: [],
    sessions: [],
    active_assignment_ids: [],
    checkpoints: [],
    interventions: [],
    blocked_stage: null,
    event_log: [],
    updated_at: timestamp,
  };
  appendRegisteredAssignment(state, buildTeamDelegateAssignment(state, input.assignment, [], timestamp));
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
  return appendRegisteredAssignment(
    state,
    buildTeamDelegateAssignment(state, assignmentInput, [], timestamp),
  );
}
