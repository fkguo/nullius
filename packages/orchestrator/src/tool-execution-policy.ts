import {
  invalidParams,
  ORCH_FLEET_ADJUDICATE_STALE_CLAIM,
  ORCH_FLEET_CLAIM,
  ORCH_FLEET_ENQUEUE,
  ORCH_FLEET_RELEASE,
  ORCH_FLEET_REASSIGN_CLAIM,
  ORCH_FLEET_STATUS,
  ORCH_FLEET_WORKER_HEARTBEAT,
  ORCH_FLEET_WORKER_POLL,
  ORCH_FLEET_WORKER_SET_CLAIM_ACCEPTANCE,
  ORCH_FLEET_WORKER_UNREGISTER,
  ORCH_POLICY_QUERY,
  ORCH_RUN_APPROVALS_LIST,
  ORCH_RUN_APPROVE,
  ORCH_RUN_CREATE,
  ORCH_RUN_EXECUTE_AGENT,
  ORCH_RUN_EXPORT,
  ORCH_RUN_LIST,
  ORCH_RUN_PAUSE,
  ORCH_RUN_REJECT,
  ORCH_RUN_RESUME,
  ORCH_RUN_STATUS,
} from '@autoresearch/shared';

import type { Tool } from './backends/chat-backend.js';

export type ToolMutationClass = 'read_only' | 'stateful' | 'approval_required';
export type ToolConcurrencyClass = 'serial_only';

export interface ToolExecutionPolicyDefinition {
  mutation_class: ToolMutationClass;
  concurrency: ToolConcurrencyClass;
}

export interface ToolExecutionPolicy extends ToolExecutionPolicyDefinition {
  tool_name: string;
  metadata_source: 'registry' | 'safe_fallback';
}

export type ToolExecutionPolicyTable = Readonly<Record<string, ToolExecutionPolicyDefinition>>;

export interface ToolPermissionView {
  scope: 'agent_session' | 'delegated_assignment';
  actor_id: string | null;
  authority: 'runtime_tools' | 'team_permission_matrix';
  allowed_tool_names: string[];
  execution_policies: Record<string, ToolExecutionPolicy>;
}

const READ_ONLY_SERIAL_POLICY: ToolExecutionPolicyDefinition = {
  mutation_class: 'read_only',
  concurrency: 'serial_only',
};

const STATEFUL_SERIAL_POLICY: ToolExecutionPolicyDefinition = {
  mutation_class: 'stateful',
  concurrency: 'serial_only',
};

const APPROVAL_REQUIRED_SERIAL_POLICY: ToolExecutionPolicyDefinition = {
  mutation_class: 'approval_required',
  concurrency: 'serial_only',
};

export const SAFE_FALLBACK_TOOL_EXECUTION_POLICY: ToolExecutionPolicyDefinition = STATEFUL_SERIAL_POLICY;

export const ORCHESTRATOR_TOOL_EXECUTION_POLICIES: ToolExecutionPolicyTable = {
  [ORCH_RUN_STATUS]: READ_ONLY_SERIAL_POLICY,
  [ORCH_RUN_LIST]: READ_ONLY_SERIAL_POLICY,
  [ORCH_RUN_APPROVALS_LIST]: READ_ONLY_SERIAL_POLICY,
  [ORCH_POLICY_QUERY]: READ_ONLY_SERIAL_POLICY,
  [ORCH_FLEET_STATUS]: READ_ONLY_SERIAL_POLICY,

  [ORCH_RUN_CREATE]: STATEFUL_SERIAL_POLICY,
  [ORCH_RUN_PAUSE]: STATEFUL_SERIAL_POLICY,
  [ORCH_RUN_RESUME]: STATEFUL_SERIAL_POLICY,
  [ORCH_FLEET_ENQUEUE]: STATEFUL_SERIAL_POLICY,
  [ORCH_FLEET_CLAIM]: STATEFUL_SERIAL_POLICY,
  [ORCH_FLEET_ADJUDICATE_STALE_CLAIM]: STATEFUL_SERIAL_POLICY,
  [ORCH_FLEET_REASSIGN_CLAIM]: STATEFUL_SERIAL_POLICY,
  [ORCH_FLEET_RELEASE]: STATEFUL_SERIAL_POLICY,
  [ORCH_FLEET_WORKER_POLL]: STATEFUL_SERIAL_POLICY,
  [ORCH_FLEET_WORKER_HEARTBEAT]: STATEFUL_SERIAL_POLICY,
  [ORCH_FLEET_WORKER_SET_CLAIM_ACCEPTANCE]: STATEFUL_SERIAL_POLICY,
  [ORCH_FLEET_WORKER_UNREGISTER]: STATEFUL_SERIAL_POLICY,

  [ORCH_RUN_APPROVE]: APPROVAL_REQUIRED_SERIAL_POLICY,
  [ORCH_RUN_REJECT]: APPROVAL_REQUIRED_SERIAL_POLICY,
  [ORCH_RUN_EXPORT]: APPROVAL_REQUIRED_SERIAL_POLICY,
  [ORCH_RUN_EXECUTE_AGENT]: APPROVAL_REQUIRED_SERIAL_POLICY,
};

function uniqueToolNames(tools: ReadonlyArray<Pick<Tool, 'name'>>): string[] {
  const names = new Set<string>();
  for (const tool of tools) {
    names.add(tool.name);
  }
  return [...names];
}

export function resolveToolExecutionPolicy(
  toolName: string,
  table: ToolExecutionPolicyTable = ORCHESTRATOR_TOOL_EXECUTION_POLICIES,
): ToolExecutionPolicy {
  const definition = table[toolName];
  if (definition) {
    return {
      tool_name: toolName,
      metadata_source: 'registry',
      mutation_class: definition.mutation_class,
      concurrency: definition.concurrency,
    };
  }
  return {
    tool_name: toolName,
    metadata_source: 'safe_fallback',
    mutation_class: SAFE_FALLBACK_TOOL_EXECUTION_POLICY.mutation_class,
    concurrency: SAFE_FALLBACK_TOOL_EXECUTION_POLICY.concurrency,
  };
}

export function buildRuntimeToolPermissionView(params: {
  tools: ReadonlyArray<Pick<Tool, 'name'>>;
  allowedToolNames?: ReadonlyArray<string>;
  scope?: ToolPermissionView['scope'];
  actorId?: string | null;
  authority?: ToolPermissionView['authority'];
}): ToolPermissionView {
  const runtimeToolNames = uniqueToolNames(params.tools);
  const allowedSet = params.allowedToolNames ? new Set(params.allowedToolNames) : null;
  const allowedToolNames = allowedSet
    ? runtimeToolNames.filter(toolName => allowedSet.has(toolName))
    : runtimeToolNames;

  return {
    scope: params.scope ?? 'agent_session',
    actor_id: params.actorId ?? null,
    authority: params.authority ?? 'runtime_tools',
    allowed_tool_names: allowedToolNames,
    execution_policies: Object.fromEntries(
      allowedToolNames.map(toolName => [toolName, resolveToolExecutionPolicy(toolName)]),
    ),
  };
}

export function filterToolsForPermissionView<T extends Pick<Tool, 'name'>>(
  tools: ReadonlyArray<T>,
  permissionView: ToolPermissionView,
): T[] {
  const allowed = new Set(permissionView.allowed_tool_names);
  return tools.filter(tool => allowed.has(tool.name));
}

export function assertToolCallAllowed(
  toolName: string,
  permissionView: ToolPermissionView | null | undefined,
): ToolExecutionPolicy | null {
  if (!permissionView) {
    return null;
  }
  if (!permissionView.allowed_tool_names.includes(toolName)) {
    throw invalidParams(
      `Tool call denied: ${toolName} is not visible in the current runtime permission view.`,
      {
        tool_name: toolName,
        actor_id: permissionView.actor_id,
        authority: permissionView.authority,
        allowed_tool_names: permissionView.allowed_tool_names,
      },
    );
  }
  return permissionView.execution_policies[toolName] ?? resolveToolExecutionPolicy(toolName);
}
