import type { MessageParam, Tool } from './backends/chat-backend.js';
import type { ExecuteDelegatedAgentRuntimeInput } from './research-loop/delegated-agent-runtime.js';
import { executeUnifiedTeamRuntime } from './team-unified-runtime.js';
import type { TeamCoordinationPolicy, TeamInterventionCommand, TeamPermissionMatrix } from './team-execution-types.js';
import type { ExecuteTeamDelegatedRuntimeResult } from './team-execution-runtime-types.js';

export interface ExecuteTeamDelegatedRuntimeInput
  extends Pick<ExecuteDelegatedAgentRuntimeInput, 'approvalGate' | 'backendFactory' | 'maxTurns' | 'mcpClient' | 'model' | 'projectRoot' | 'routingConfig' | 'runId' | 'spanCollector' | '_messagesCreate'> {
  workspaceId: string;
  taskId: string;
  ownerRole: string;
  delegateRole: string;
  delegateId: string;
  coordinationPolicy: TeamCoordinationPolicy;
  permissions: TeamPermissionMatrix;
  taskKind?: TeamPermissionMatrix['delegation'][number]['allowed_task_kinds'][number];
  messages: MessageParam[];
  tools: Tool[];
  handoffId?: string | null;
  handoffKind?: TeamPermissionMatrix['delegation'][number]['allowed_handoff_kinds'][number] | null;
  checkpointId?: string | null;
  interventions?: TeamInterventionCommand[];
  resumeFrom?: string;
}

export async function executeTeamDelegatedRuntime(
  input: ExecuteTeamDelegatedRuntimeInput,
): Promise<ExecuteTeamDelegatedRuntimeResult> {
  const unified = await executeUnifiedTeamRuntime({
    projectRoot: input.projectRoot,
    runId: input.runId,
    workspaceId: input.workspaceId,
    coordinationPolicy: input.coordinationPolicy,
    permissions: input.permissions,
    assignments: [{
      stage: 0,
      owner_role: input.ownerRole,
      delegate_role: input.delegateRole,
      delegate_id: input.delegateId,
      task_id: input.taskId,
      task_kind: input.taskKind ?? 'compute',
      handoff_id: input.handoffId ?? null,
      handoff_kind: input.handoffKind ?? null,
      checkpoint_id: input.checkpointId ?? null,
    }],
    messages: input.messages,
    tools: input.tools,
    interventions: input.interventions,
    model: input.model,
    mcpClient: input.mcpClient,
    approvalGate: input.approvalGate,
    resumeFrom: input.resumeFrom,
    maxTurns: input.maxTurns,
    routingConfig: input.routingConfig,
    spanCollector: input.spanCollector,
    backendFactory: input.backendFactory,
    _messagesCreate: input._messagesCreate,
  });
  const primary = unified.assignment_results[0];
  if (!primary) {
    throw new Error('team runtime did not produce a primary assignment result');
  }
  return {
    assignment_id: primary.assignment_id,
    events: primary.events,
    last_completed_step: primary.last_completed_step,
    manifest_path: primary.manifest_path,
    resume_from: primary.resume_from,
    resumed: primary.resumed,
    skipped_step_ids: primary.skipped_step_ids,
    team_state: unified.team_state,
    team_state_path: unified.team_state_path,
  };
}
