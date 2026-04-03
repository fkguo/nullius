import type { Tool } from './backends/chat-backend.js';
import type { TeamExecutionAssignmentInput, TeamInterventionCommand, TeamPermissionMatrix } from './team-execution-types.js';
import { buildRuntimeToolPermissionView, type ToolPermissionView } from './tool-execution-policy.js';

function findDelegationPermission(
  permissions: TeamPermissionMatrix,
  assignment: TeamExecutionAssignmentInput,
) {
  return permissions.delegation.find(
    entry => entry.from_role === assignment.owner_role && entry.to_role === assignment.delegate_role,
  );
}

export function assertDelegationAllowed(
  permissions: TeamPermissionMatrix,
  assignment: TeamExecutionAssignmentInput,
): void {
  const match = findDelegationPermission(permissions, assignment);
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

export function buildDelegatedToolPermissionView(
  permissions: TeamPermissionMatrix,
  assignment: TeamExecutionAssignmentInput,
  tools: ReadonlyArray<Pick<Tool, 'name'>>,
): ToolPermissionView {
  const match = findDelegationPermission(permissions, assignment);
  if (!match) {
    throw new Error(`delegation denied: ${assignment.owner_role} cannot delegate to ${assignment.delegate_role}`);
  }
  return buildRuntimeToolPermissionView({
    tools,
    allowedToolNames: match.allowed_tool_names,
    scope: 'delegated_assignment',
    actorId: assignment.delegate_id,
    authority: 'team_permission_matrix',
  });
}

export function assertInterventionAllowed(
  permissions: TeamPermissionMatrix,
  command: TeamInterventionCommand,
): void {
  const candidates = permissions.interventions.filter(entry => entry.actor_role === command.actor_role);
  if (candidates.length === 0) {
    throw new Error(`intervention denied: role ${command.actor_role} has no intervention permissions`);
  }
  const scoped = candidates.filter(entry => entry.allowed_scopes.includes(command.scope));
  if (scoped.length === 0) {
    throw new Error(`intervention denied: scope ${command.scope} is not allowed for role ${command.actor_role}`);
  }
  if (!scoped.some(entry => entry.allowed_kinds.includes(command.kind))) {
    throw new Error(`intervention denied: kind ${command.kind} is not allowed for role ${command.actor_role}`);
  }
}
