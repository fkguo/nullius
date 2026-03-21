import { ApprovalGate } from './approval-gate.js';
import { createStateManager, requireState } from './orch-tools/common.js';
import { executeTeamDelegatedRuntime } from './team-execution-runtime.js';
import { executeUnifiedTeamRuntime } from './team-unified-runtime.js';
import type { AgentToolHandlerContext } from './orch-tools/agent-runtime.js';
import type { ExecuteTeamDelegatedRuntimeInput } from './team-execution-runtime.js';
import type { ExecuteTeamDelegatedRuntimeResult } from './team-execution-runtime-types.js';
import type { TeamPermissionMatrix } from './team-execution-types.js';
import type { ExecuteUnifiedTeamRuntimeResult } from './team-unified-runtime-types.js';
import {
  buildTeamAssignments,
  createLoopbackToolCaller,
  createSamplingAdapter,
  defaultTeamPermissions,
} from './team-execution-tool-bridge.js';

type ExecuteTeamRuntimeFromToolParamsResult =
  ExecuteTeamDelegatedRuntimeResult
  & Pick<ExecuteUnifiedTeamRuntimeResult, 'assignment_results' | 'blocked_stage' | 'live_status' | 'replay'>;

export async function executeDefaultTeamDelegatedRuntime(
  input: Omit<ExecuteTeamDelegatedRuntimeInput, 'permissions'>,
): Promise<ReturnType<typeof executeTeamDelegatedRuntime>> {
  return executeTeamDelegatedRuntime({ ...input, permissions: defaultTeamPermissions() });
}

export async function executeTeamRuntimeFromToolParams(
  params: {
    project_root: string;
    run_id: string;
    model: string;
    messages: ExecuteTeamDelegatedRuntimeInput['messages'];
    tools: ExecuteTeamDelegatedRuntimeInput['tools'];
    resume_from?: string;
    max_turns?: number;
    team?: {
      workspace_id?: string;
      task_id?: string;
      owner_role?: string;
      delegate_role?: string;
      delegate_id?: string;
      coordination_policy?: ExecuteTeamDelegatedRuntimeInput['coordinationPolicy'];
      task_kind?: ExecuteTeamDelegatedRuntimeInput['taskKind'];
      handoff_id?: string | null;
      handoff_kind?: ExecuteTeamDelegatedRuntimeInput['handoffKind'];
      checkpoint_id?: string | null;
      timeout_at?: string | null;
      assignments?: Array<{
        stage?: number;
        task_id: string;
        task_kind?: ExecuteTeamDelegatedRuntimeInput['taskKind'];
        owner_role?: string;
        delegate_role?: string;
        delegate_id?: string;
        handoff_id?: string | null;
        handoff_kind?: ExecuteTeamDelegatedRuntimeInput['handoffKind'];
        checkpoint_id?: string | null;
        timeout_at?: string | null;
      }>;
      permissions?: TeamPermissionMatrix;
      interventions?: ExecuteTeamDelegatedRuntimeInput['interventions'];
    };
  },
  ctx: AgentToolHandlerContext,
): Promise<ExecuteTeamRuntimeFromToolParamsResult> {
  const { manager, projectRoot } = createStateManager(params.project_root);
  const state = requireState(projectRoot, manager);
  const team = params.team ?? {};
  const workspaceId = team.workspace_id ?? state.run_id ?? `workspace:${params.run_id}`;
  const assignments = buildTeamAssignments(
    team,
    state.current_step?.step_id ?? 'delegate-task',
    team.owner_role ?? 'lead',
    team.delegate_role ?? 'delegate',
    team.delegate_id ?? 'delegate',
  );
  const unified = await executeUnifiedTeamRuntime({
    projectRoot,
    runId: params.run_id,
    workspaceId,
    coordinationPolicy: team.coordination_policy ?? 'supervised_delegate',
    permissions: team.permissions ?? defaultTeamPermissions(),
    assignments,
    messages: params.messages,
    tools: params.tools,
    model: params.model,
    interventions: team.interventions,
    resumeFrom: params.resume_from,
    maxTurns: params.max_turns,
    mcpClient: createLoopbackToolCaller(ctx),
    approvalGate: new ApprovalGate({}),
    _messagesCreate: createSamplingAdapter(ctx),
  });
  const primary = unified.assignment_results[0];
  if (!primary) {
    throw new Error('team runtime did not return any assignment results');
  }
  return {
    assignment_id: primary.assignment_id,
    events: primary.events,
    last_completed_step: primary.last_completed_step,
    manifest_path: primary.manifest_path,
    resume_from: primary.resume_from,
    resumed: primary.resumed,
    skipped_step_ids: primary.skipped_step_ids,
    ...unified,
  };
}
