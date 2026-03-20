import type { TeamExecutionAssignmentInput, TeamInterventionCommand, TeamPermissionMatrix } from './team-execution-types.js';

export function assertDelegationAllowed(
  permissions: TeamPermissionMatrix,
  assignment: TeamExecutionAssignmentInput,
): void {
  const match = permissions.delegation.find(
    entry => entry.from_role === assignment.owner_role && entry.to_role === assignment.delegate_role,
  );
  if (!match) {
    throw new Error(`delegation denied: ${assignment.owner_role} cannot delegate to ${assignment.delegate_role}`);
  }
  if (!match.allowed_task_kinds.includes(assignment.task_kind)) {
    throw new Error(
      `delegation denied: task kind ${assignment.task_kind} is not allowed for ${assignment.owner_role} -> ${assignment.delegate_role}`,
    );
  }
  if (assignment.handoff_kind && !match.allowed_handoff_kinds.includes(assignment.handoff_kind)) {
    throw new Error(
      `delegation denied: handoff kind ${assignment.handoff_kind} is not allowed for ${assignment.owner_role} -> ${assignment.delegate_role}`,
    );
  }
}

export function assertInterventionAllowed(
  permissions: TeamPermissionMatrix,
  command: TeamInterventionCommand,
): void {
  const match = permissions.interventions.find(entry => entry.actor_role === command.actor_role);
  if (!match) {
    throw new Error(`intervention denied: role ${command.actor_role} has no intervention permissions`);
  }
  if (!match.allowed_scopes.includes(command.scope)) {
    throw new Error(`intervention denied: scope ${command.scope} is not allowed for role ${command.actor_role}`);
  }
  if (!match.allowed_kinds.includes(command.kind)) {
    throw new Error(`intervention denied: kind ${command.kind} is not allowed for role ${command.actor_role}`);
  }
}
