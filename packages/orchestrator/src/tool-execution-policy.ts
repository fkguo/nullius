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
import type { RuntimePermissionProfileV1 } from './runtime-permission-profile.js';

export type ToolMutationClass = 'read_only' | 'stateful' | 'approval_required';
export type ToolConcurrencyClass = 'serial_only' | 'batch_safe';

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
  scope: RuntimePermissionProfileV1['actor']['scope'];
  actor_id: string | null;
  authority: 'runtime_permission_profile';
  authority_source: RuntimePermissionProfileV1['actor']['source'];
  allowed_tool_names: string[];
  execution_policies: Record<string, ToolExecutionPolicy>;
}

const READ_ONLY_BATCH_SAFE_POLICY: ToolExecutionPolicyDefinition = {
  mutation_class: 'read_only',
  concurrency: 'batch_safe',
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
  [ORCH_RUN_STATUS]: READ_ONLY_BATCH_SAFE_POLICY,
  [ORCH_RUN_LIST]: READ_ONLY_BATCH_SAFE_POLICY,
  [ORCH_RUN_APPROVALS_LIST]: READ_ONLY_BATCH_SAFE_POLICY,
  [ORCH_POLICY_QUERY]: READ_ONLY_BATCH_SAFE_POLICY,
  [ORCH_FLEET_STATUS]: READ_ONLY_BATCH_SAFE_POLICY,

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

export function safeFallbackToolExecutionPolicy(toolName: string): ToolExecutionPolicy {
  return {
    tool_name: toolName,
    metadata_source: 'safe_fallback',
    mutation_class: SAFE_FALLBACK_TOOL_EXECUTION_POLICY.mutation_class,
    concurrency: SAFE_FALLBACK_TOOL_EXECUTION_POLICY.concurrency,
  };
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
  return safeFallbackToolExecutionPolicy(toolName);
}

export function isParallelBatchSafeToolExecutionPolicy(
  policy: Pick<ToolExecutionPolicyDefinition, 'mutation_class' | 'concurrency'> | null | undefined,
): boolean {
  return policy?.mutation_class === 'read_only' && policy.concurrency === 'batch_safe';
}

export function buildRuntimeToolPermissionView(
  permissionProfile: RuntimePermissionProfileV1,
): ToolPermissionView {
  return {
    scope: permissionProfile.actor.scope,
    actor_id: permissionProfile.actor.actor_id,
    authority: 'runtime_permission_profile',
    authority_source: permissionProfile.actor.source,
    allowed_tool_names: [...permissionProfile.tools.allowed_tool_names],
    execution_policies: { ...permissionProfile.tools.execution_policies },
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
        authority_source: permissionView.authority_source,
        allowed_tool_names: permissionView.allowed_tool_names,
      },
    );
  }
  return permissionView.execution_policies[toolName] ?? resolveToolExecutionPolicy(toolName);
}
