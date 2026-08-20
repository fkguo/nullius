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
  ORCH_RUN_EXECUTE_MANIFEST,
  ORCH_RUN_EXECUTE_AGENT,
  ORCH_RUN_EXPORT,
  ORCH_RUN_LIST,
  ORCH_RUN_PLAN_COMPUTATION,
  ORCH_RUN_PROGRESS_FOLLOWUPS,
  ORCH_RUN_RECORD_PROPOSAL_DECISION,
  ORCH_RUN_RECORD_VERIFICATION,
  ORCH_RUN_REQUEST_FINAL_CONCLUSIONS,
  ORCH_RUN_PAUSE,
  ORCH_RUN_REJECT,
  ORCH_RUN_RESUME,
  ORCH_RUN_STAGE_CONTENT,
  ORCH_RUN_STAGE_IDEA,
  ORCH_RUN_STATUS,
} from '@nullius/shared';

import type { Tool } from './backends/chat-backend.js';
import type { RuntimePermissionProfileV1 } from './runtime-permission-profile.js';

export type ToolMutationClass = 'read_only' | 'stateful';
export type ToolConcurrencyClass = 'serial_only' | 'batch_safe';
export type ToolApprovalBehavior = 'none' | 'may_request' | 'resolves_approval';

export interface ToolExecutionPolicyDefinition {
  mutation_class: ToolMutationClass;
  concurrency: ToolConcurrencyClass;
  approval_behavior: ToolApprovalBehavior;
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
  approvals: RuntimePermissionProfileV1['approvals'];
}

const READ_ONLY_BATCH_SAFE_POLICY: ToolExecutionPolicyDefinition = {
  mutation_class: 'read_only',
  concurrency: 'batch_safe',
  approval_behavior: 'none',
};

const STATEFUL_SERIAL_POLICY: ToolExecutionPolicyDefinition = {
  mutation_class: 'stateful',
  concurrency: 'serial_only',
  approval_behavior: 'none',
};

const READ_ONLY_SERIAL_POLICY: ToolExecutionPolicyDefinition = {
  mutation_class: 'read_only',
  concurrency: 'serial_only',
  approval_behavior: 'none',
};

const MAY_REQUEST_APPROVAL_SERIAL_POLICY: ToolExecutionPolicyDefinition = {
  mutation_class: 'stateful',
  concurrency: 'serial_only',
  approval_behavior: 'may_request',
};

const RESOLVES_APPROVAL_SERIAL_POLICY: ToolExecutionPolicyDefinition = {
  mutation_class: 'stateful',
  concurrency: 'serial_only',
  approval_behavior: 'resolves_approval',
};

export const SAFE_FALLBACK_TOOL_EXECUTION_POLICY: ToolExecutionPolicyDefinition = STATEFUL_SERIAL_POLICY;

export const ORCHESTRATOR_TOOL_EXECUTION_POLICIES: ToolExecutionPolicyTable = {
  [ORCH_RUN_STATUS]: READ_ONLY_BATCH_SAFE_POLICY,
  [ORCH_RUN_LIST]: READ_ONLY_BATCH_SAFE_POLICY,
  [ORCH_RUN_APPROVALS_LIST]: READ_ONLY_BATCH_SAFE_POLICY,
  [ORCH_POLICY_QUERY]: READ_ONLY_BATCH_SAFE_POLICY,
  [ORCH_FLEET_STATUS]: READ_ONLY_BATCH_SAFE_POLICY,

  [ORCH_RUN_CREATE]: STATEFUL_SERIAL_POLICY,
  [ORCH_RUN_STAGE_IDEA]: STATEFUL_SERIAL_POLICY,
  [ORCH_RUN_STAGE_CONTENT]: STATEFUL_SERIAL_POLICY,
  [ORCH_RUN_RECORD_PROPOSAL_DECISION]: STATEFUL_SERIAL_POLICY,
  [ORCH_RUN_RECORD_VERIFICATION]: STATEFUL_SERIAL_POLICY,
  [ORCH_RUN_PAUSE]: STATEFUL_SERIAL_POLICY,
  [ORCH_RUN_RESUME]: STATEFUL_SERIAL_POLICY,
  [ORCH_RUN_PROGRESS_FOLLOWUPS]: STATEFUL_SERIAL_POLICY,
  [ORCH_RUN_EXECUTE_AGENT]: STATEFUL_SERIAL_POLICY,
  [ORCH_FLEET_ENQUEUE]: STATEFUL_SERIAL_POLICY,
  [ORCH_FLEET_CLAIM]: STATEFUL_SERIAL_POLICY,
  [ORCH_FLEET_ADJUDICATE_STALE_CLAIM]: STATEFUL_SERIAL_POLICY,
  [ORCH_FLEET_REASSIGN_CLAIM]: STATEFUL_SERIAL_POLICY,
  [ORCH_FLEET_RELEASE]: STATEFUL_SERIAL_POLICY,
  [ORCH_FLEET_WORKER_POLL]: STATEFUL_SERIAL_POLICY,
  [ORCH_FLEET_WORKER_HEARTBEAT]: STATEFUL_SERIAL_POLICY,
  [ORCH_FLEET_WORKER_SET_CLAIM_ACCEPTANCE]: STATEFUL_SERIAL_POLICY,
  [ORCH_FLEET_WORKER_UNREGISTER]: STATEFUL_SERIAL_POLICY,

  [ORCH_RUN_PLAN_COMPUTATION]: MAY_REQUEST_APPROVAL_SERIAL_POLICY,
  [ORCH_RUN_EXECUTE_MANIFEST]: MAY_REQUEST_APPROVAL_SERIAL_POLICY,
  [ORCH_RUN_REQUEST_FINAL_CONCLUSIONS]: MAY_REQUEST_APPROVAL_SERIAL_POLICY,

  [ORCH_RUN_APPROVE]: RESOLVES_APPROVAL_SERIAL_POLICY,
  [ORCH_RUN_REJECT]: RESOLVES_APPROVAL_SERIAL_POLICY,

  [ORCH_RUN_EXPORT]: READ_ONLY_SERIAL_POLICY,
};

export function safeFallbackToolExecutionPolicy(toolName: string): ToolExecutionPolicy {
  return {
    tool_name: toolName,
    metadata_source: 'safe_fallback',
    mutation_class: SAFE_FALLBACK_TOOL_EXECUTION_POLICY.mutation_class,
    concurrency: SAFE_FALLBACK_TOOL_EXECUTION_POLICY.concurrency,
    approval_behavior: SAFE_FALLBACK_TOOL_EXECUTION_POLICY.approval_behavior,
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
      approval_behavior: definition.approval_behavior,
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
  const executionPolicies = Object.fromEntries(
    permissionProfile.tools.allowed_tool_names.map(toolName => [
      toolName,
      resolveToolExecutionPolicy(toolName),
    ]),
  );
  return {
    scope: permissionProfile.actor.scope,
    actor_id: permissionProfile.actor.actor_id,
    authority: 'runtime_permission_profile',
    authority_source: permissionProfile.actor.source,
    allowed_tool_names: [...permissionProfile.tools.allowed_tool_names],
    execution_policies: executionPolicies,
    approvals: { ...permissionProfile.approvals },
  };
}

export function filterToolsForPermissionView<T extends Pick<Tool, 'name'>>(
  tools: ReadonlyArray<T>,
  permissionView: ToolPermissionView,
): T[] {
  const allowed = new Set(permissionView.allowed_tool_names);
  return tools.filter(tool => (
    allowed.has(tool.name)
    && resolveToolExecutionPolicy(tool.name).approval_behavior !== 'resolves_approval'
  ));
}

export function assertToolCallAllowed(
  toolName: string,
  permissionView: ToolPermissionView,
): ToolExecutionPolicy {
  if (!permissionView) {
    throw invalidParams(
      `Tool call denied: ${toolName} has no runtime permission view.`,
      { tool_name: toolName, authority: 'runtime_permission_profile' },
    );
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
  const authoritativePolicy = resolveToolExecutionPolicy(toolName);
  const snapshotPolicy = permissionView.execution_policies[toolName];
  if (!snapshotPolicy
    || snapshotPolicy.tool_name !== authoritativePolicy.tool_name
    || snapshotPolicy.metadata_source !== authoritativePolicy.metadata_source
    || snapshotPolicy.mutation_class !== authoritativePolicy.mutation_class
    || snapshotPolicy.concurrency !== authoritativePolicy.concurrency
    || snapshotPolicy.approval_behavior !== authoritativePolicy.approval_behavior) {
    throw invalidParams(
      `Tool call denied: ${toolName} has a stale or forged execution policy in the runtime permission view.`,
      {
        tool_name: toolName,
        actor_id: permissionView.actor_id,
        authority: permissionView.authority,
        authority_source: permissionView.authority_source,
        expected_execution_policy: authoritativePolicy,
        observed_execution_policy: snapshotPolicy ?? null,
      },
    );
  }
  if (authoritativePolicy.approval_behavior === 'resolves_approval') {
    throw invalidParams(
      `Tool call denied: ${toolName} resolves an approval and is reserved for the host/operator boundary.`,
      {
        tool_name: toolName,
        actor_scope: permissionView.scope,
        actor_id: permissionView.actor_id,
        authority: permissionView.authority,
        authority_source: permissionView.authority_source,
        approval_behavior: authoritativePolicy.approval_behavior,
      },
    );
  }
  return authoritativePolicy;
}
