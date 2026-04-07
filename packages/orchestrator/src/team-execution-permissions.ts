import type { Tool } from './backends/chat-backend.js';
import {
  buildRuntimePermissionProfileV1,
  type RuntimePermissionProfileV1,
} from './runtime-permission-profile.js';
import type {
  TeamExecutionAssignmentInput,
  TeamDelegateAssignment,
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
  assignment: DelegatedRuntimePermissionCompileInput,
  tools: ReadonlyArray<Pick<Tool, 'name'>>,
  state?: Pick<TeamExecutionState, 'delegate_assignments'>,
): ToolPermissionView {
  return buildRuntimeToolPermissionView(
    compileDelegatedRuntimePermissionProfile(permissions, assignment, tools, state),
  );
}

type DelegatedRuntimePermissionCompileInput = TeamExecutionAssignmentInput & Partial<Pick<
  TeamDelegateAssignment,
  'approval_id' | 'approval_packet_path' | 'approval_requested_at'
>>;

function runtimeToolNames(tools: ReadonlyArray<Pick<Tool, 'name'>>): string[] {
  const names = new Set<string>();
  for (const tool of tools) {
    names.add(tool.name);
  }
  return [...names];
}

function filterAllowedToolNames(
  tools: ReadonlyArray<Pick<Tool, 'name'>>,
  allowedToolNames?: ReadonlyArray<string>,
): string[] {
  const runtimeNames = runtimeToolNames(tools);
  const allowedSet = allowedToolNames ? new Set(allowedToolNames) : null;
  return allowedSet ? runtimeNames.filter(toolName => allowedSet.has(toolName)) : runtimeNames;
}

export function compileDelegatedRuntimePermissionProfile(
  permissions: TeamPermissionMatrix,
  assignment: DelegatedRuntimePermissionCompileInput,
  tools: ReadonlyArray<Pick<Tool, 'name'>>,
  state?: Pick<TeamExecutionState, 'delegate_assignments'>,
): RuntimePermissionProfileV1 {
  const match = findDelegationPermission(permissions, assignment);
  if (!match) {
    throw new Error(`delegation denied: ${assignment.owner_role} cannot delegate to ${assignment.delegate_role}`);
  }
  const matrixAllowedToolNames = filterAllowedToolNames(tools, match.allowed_tool_names);

  const inheritance: TeamMcpToolInheritance = assignment.mcp_tool_inheritance ?? { mode: 'team_permission_matrix' };
  if (inheritance.mode === 'team_permission_matrix' && inheritance.additive_tool_names === undefined) {
    return buildRuntimePermissionProfileV1({
      tools,
      allowedToolNames: matrixAllowedToolNames,
      actorScope: 'delegated_assignment',
      actorId: assignment.delegate_id,
      actorSource: 'team_permission_matrix',
      inheritanceMode: 'team_permission_matrix',
      approvals: {
        mode: 'inherit_gate',
        grant_scope: 'assignment',
        reviewer: assignment.owner_role,
        assignment_approval_id: assignment.approval_id ?? null,
        assignment_approval_packet_path: assignment.approval_packet_path ?? null,
        assignment_approval_requested_at: assignment.approval_requested_at ?? null,
      },
    });
  }
  if (inheritance.mode === 'inherit_from_assignment' && !state) {
    throw new Error('delegated MCP/tool inheritance requires TeamExecutionState context');
  }

  const runtimeToolNameSet = new Set(runtimeToolNames(tools));
  const allowedByMatrix = new Set(matrixAllowedToolNames);

  const normalizeToolNames = (toolNames: ReadonlyArray<string> | undefined): string[] => {
    if (!toolNames) return [];
    return toolNames.map(name => String(name)).filter(name => name.length > 0);
  };

  const validateAdditiveOverride = (toolNames: string[]): void => {
    // The top-level additive override must already be matrix-bounded for the
    // child assignment before we recurse. The recursive loop below then repeats
    // the same checks against each current assignment's matrix-bounded tool set
    // so inherited parents cannot smuggle in out-of-matrix additive tools.
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
    const matrixAllowed = filterAllowedToolNames(tools, permissionMatch.allowed_tool_names);
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
  return buildRuntimePermissionProfileV1({
    tools,
    allowedToolNames,
    actorScope: 'delegated_assignment',
    actorId: assignment.delegate_id,
    actorSource: 'team_permission_matrix',
    inheritanceMode: inheritance.mode,
    inheritFromAssignmentId: inheritance.mode === 'inherit_from_assignment'
      ? inheritance.inherit_from_assignment_id
      : undefined,
    approvals: {
      mode: 'inherit_gate',
      grant_scope: 'assignment',
      reviewer: assignment.owner_role,
      assignment_approval_id: assignment.approval_id ?? null,
      assignment_approval_packet_path: assignment.approval_packet_path ?? null,
      assignment_approval_requested_at: assignment.approval_requested_at ?? null,
    },
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
