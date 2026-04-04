import type { Tool } from './backends/chat-backend.js';
import type {
  TeamExecutionAssignmentInput,
  TeamExecutionState,
  TeamInterventionCommand,
  TeamMcpToolInheritance,
  TeamPermissionMatrix,
} from './team-execution-types.js';
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
  state?: Pick<TeamExecutionState, 'delegate_assignments'>,
): ToolPermissionView {
  const match = findDelegationPermission(permissions, assignment);
  if (!match) {
    throw new Error(`delegation denied: ${assignment.owner_role} cannot delegate to ${assignment.delegate_role}`);
  }
  const base = buildRuntimeToolPermissionView({
    tools,
    allowedToolNames: match.allowed_tool_names,
    scope: 'delegated_assignment',
    actorId: assignment.delegate_id,
    authority: 'team_permission_matrix',
  });

  const inheritance: TeamMcpToolInheritance = assignment.mcp_tool_inheritance ?? { mode: 'team_permission_matrix' };
  if (inheritance.mode === 'team_permission_matrix' && inheritance.additive_tool_names === undefined) {
    return base;
  }
  if (inheritance.mode === 'inherit_from_assignment' && !state) {
    throw new Error('delegated MCP/tool inheritance requires TeamExecutionState context');
  }

  const runtimeToolNameSet = new Set(tools.map(tool => tool.name));
  const allowedByMatrix = new Set(base.allowed_tool_names);

  const normalizeToolNames = (toolNames: ReadonlyArray<string> | undefined): string[] => {
    if (!toolNames) return [];
    return toolNames.map(name => String(name)).filter(name => name.length > 0);
  };

  const validateAdditiveOverride = (toolNames: string[]): void => {
    for (const toolName of toolNames) {
      if (!runtimeToolNameSet.has(toolName)) {
        throw new Error(`delegated MCP/tool inheritance denied: additive tool '${toolName}' is not present in runtime tools`);
      }
      if (!allowedByMatrix.has(toolName)) {
        throw new Error(
          `delegated MCP/tool inheritance denied: additive tool '${toolName}' is not allowed by the team permission matrix`,
        );
      }
    }
  };

  const resolveAllowedToolNames = (
    current: TeamExecutionAssignmentInput,
    visited: Set<string>,
  ): string[] => {
    const permissionMatch = findDelegationPermission(permissions, current);
    if (!permissionMatch) {
      throw new Error(`delegation denied: ${current.owner_role} cannot delegate to ${current.delegate_role}`);
    }
    const matrixView = buildRuntimeToolPermissionView({
      tools,
      allowedToolNames: permissionMatch.allowed_tool_names,
      scope: 'delegated_assignment',
      actorId: current.delegate_id,
      authority: 'team_permission_matrix',
    });
    const matrixAllowed = matrixView.allowed_tool_names;
    const currentInheritance: TeamMcpToolInheritance = current.mcp_tool_inheritance ?? { mode: 'team_permission_matrix' };
    const additive = normalizeToolNames(currentInheritance.additive_tool_names);
    const additiveSet = new Set(additive);
    const runtimeSet = new Set(matrixAllowed);

    for (const toolName of additiveSet) {
      if (!runtimeToolNameSet.has(toolName)) {
        throw new Error(`delegated MCP/tool inheritance denied: additive tool '${toolName}' is not present in runtime tools`);
      }
      if (!runtimeSet.has(toolName)) {
        throw new Error(
          `delegated MCP/tool inheritance denied: additive tool '${toolName}' is not allowed by the team permission matrix`,
        );
      }
    }

    let inheritedBase = matrixAllowed;
    if (currentInheritance.mode === 'inherit_from_assignment') {
      const parentId = currentInheritance.inherit_from_assignment_id;
      if (visited.has(parentId)) {
        throw new Error(`delegated MCP/tool inheritance denied: inheritance cycle detected at assignment ${parentId}`);
      }
      const parent = state!.delegate_assignments.find(item => item.assignment_id === parentId);
      if (!parent) {
        throw new Error(`delegated MCP/tool inheritance denied: missing parent assignment ${parentId}`);
      }
      visited.add(parentId);
      inheritedBase = resolveAllowedToolNames(parent, visited);
    }

    const desiredSet = new Set<string>([...inheritedBase, ...additiveSet]);
    return matrixAllowed.filter(toolName => desiredSet.has(toolName));
  };

  const additiveOverride = normalizeToolNames(inheritance.additive_tool_names);
  validateAdditiveOverride(additiveOverride);
  const visited = new Set<string>();
  if (assignment.assignment_id) {
    visited.add(assignment.assignment_id);
  }
  const allowedToolNames = resolveAllowedToolNames(assignment, visited);
  return buildRuntimeToolPermissionView({
    tools,
    allowedToolNames,
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
