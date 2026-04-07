import type { Tool } from './backends/chat-backend.js';
import {
  resolveToolExecutionPolicy,
  type ToolExecutionPolicy,
} from './tool-execution-policy.js';

export type RuntimePermissionActorScope = 'agent_session' | 'delegated_assignment';
export type RuntimePermissionActorSource = 'host_runtime' | 'team_permission_matrix' | 'internal';
export type RuntimePermissionToolInheritanceMode =
  | 'runtime_tools'
  | 'team_permission_matrix'
  | 'inherit_from_assignment';
export type RuntimePermissionApprovalMode = 'inherit_gate' | 'request_explicit';
export type RuntimePermissionGrantScope = 'session' | 'assignment';
export type RuntimePermissionFilesystemMode = 'inherit_host' | 'restricted';
export type RuntimePermissionNetworkMode = 'inherit_host' | 'restricted' | 'enabled';

export interface RuntimePermissionProfileV1 {
  version: 1;
  actor: {
    scope: RuntimePermissionActorScope;
    actor_id: string | null;
    source: RuntimePermissionActorSource;
  };
  tools: {
    allowed_tool_names: string[];
    execution_policies: Record<string, ToolExecutionPolicy>;
    inheritance_mode: RuntimePermissionToolInheritanceMode;
    inherit_from_assignment_id?: string;
  };
  sandbox: {
    filesystem: null | {
      mode: RuntimePermissionFilesystemMode;
      read_roots?: string[];
      write_roots?: string[];
    };
    network: null | {
      mode: RuntimePermissionNetworkMode;
    };
  };
  approvals: {
    mode: RuntimePermissionApprovalMode;
    grant_scope: RuntimePermissionGrantScope;
    reviewer: string | null;
    assignment_approval_id?: string | null;
    assignment_approval_packet_path?: string | null;
    assignment_approval_requested_at?: string | null;
  };
}

function uniqueToolNames(tools: ReadonlyArray<Pick<Tool, 'name'>>): string[] {
  const names = new Set<string>();
  for (const tool of tools) {
    names.add(tool.name);
  }
  return [...names];
}

function materializeAllowedToolNames(
  tools: ReadonlyArray<Pick<Tool, 'name'>>,
  allowedToolNames?: ReadonlyArray<string>,
): string[] {
  const runtimeToolNames = uniqueToolNames(tools);
  const allowedSet = allowedToolNames ? new Set(allowedToolNames) : null;
  return allowedSet
    ? runtimeToolNames.filter(toolName => allowedSet.has(toolName))
    : runtimeToolNames;
}

function compileExecutionPolicies(
  allowedToolNames: ReadonlyArray<string>,
): Record<string, ToolExecutionPolicy> {
  return Object.fromEntries(
    allowedToolNames.map(toolName => [toolName, resolveToolExecutionPolicy(toolName)]),
  );
}

export function buildRuntimePermissionProfileV1(params: {
  tools: ReadonlyArray<Pick<Tool, 'name'>>;
  allowedToolNames?: ReadonlyArray<string>;
  actorScope?: RuntimePermissionActorScope;
  actorId?: string | null;
  actorSource?: RuntimePermissionActorSource;
  inheritanceMode?: RuntimePermissionToolInheritanceMode;
  inheritFromAssignmentId?: string;
  sandbox?: RuntimePermissionProfileV1['sandbox'];
  approvals?: Partial<RuntimePermissionProfileV1['approvals']>;
}): RuntimePermissionProfileV1 {
  const allowedToolNames = materializeAllowedToolNames(params.tools, params.allowedToolNames);
  return {
    version: 1,
    actor: {
      scope: params.actorScope ?? 'agent_session',
      actor_id: params.actorId ?? null,
      source: params.actorSource ?? 'internal',
    },
    tools: {
      allowed_tool_names: allowedToolNames,
      execution_policies: compileExecutionPolicies(allowedToolNames),
      inheritance_mode: params.inheritanceMode ?? 'runtime_tools',
      ...(params.inheritFromAssignmentId
        ? { inherit_from_assignment_id: params.inheritFromAssignmentId }
        : {}),
    },
    sandbox: params.sandbox ?? {
      filesystem: { mode: 'inherit_host' },
      network: { mode: 'inherit_host' },
    },
    approvals: {
      mode: params.approvals?.mode ?? 'inherit_gate',
      grant_scope: params.approvals?.grant_scope ?? 'session',
      reviewer: params.approvals?.reviewer ?? null,
      ...(params.approvals?.assignment_approval_id !== undefined
        ? { assignment_approval_id: params.approvals.assignment_approval_id }
        : {}),
      ...(params.approvals?.assignment_approval_packet_path !== undefined
        ? { assignment_approval_packet_path: params.approvals.assignment_approval_packet_path }
        : {}),
      ...(params.approvals?.assignment_approval_requested_at !== undefined
        ? { assignment_approval_requested_at: params.approvals.assignment_approval_requested_at }
        : {}),
    },
  };
}

export function buildDirectRuntimePermissionProfile(params: {
  tools: ReadonlyArray<Pick<Tool, 'name'>>;
  actorId?: string | null;
  actorSource?: Extract<RuntimePermissionActorSource, 'host_runtime' | 'internal'>;
}): RuntimePermissionProfileV1 {
  return buildRuntimePermissionProfileV1({
    tools: params.tools,
    actorScope: 'agent_session',
    actorId: params.actorId ?? null,
    actorSource: params.actorSource ?? 'host_runtime',
    inheritanceMode: 'runtime_tools',
    approvals: {
      mode: 'inherit_gate',
      grant_scope: 'session',
      reviewer: null,
    },
  });
}
