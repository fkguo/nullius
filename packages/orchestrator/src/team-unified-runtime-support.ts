import type { MessageParam } from './backends/chat-backend.js';
import { buildTeamDelegationProtocol, renderTeamDelegationProtocol, type TeamDelegationProtocol } from './delegation-protocol.js';
import type { ExecuteTeamDelegatedRuntimeResult } from './team-execution-runtime-types.js';
import type { TeamAssignmentStatus, TeamExecutionState } from './team-execution-types.js';
import { TeamExecutionStateManager } from './team-execution-storage.js';
import type {
  ExecuteUnifiedTeamRuntimeInput,
  TeamAssignmentExecutionResult,
  TeamRuntimeAssignmentInput,
} from './team-unified-runtime-types.js';

export function runtimeRunId(runId: string, assignmentId: string): string {
  return `${runId}__${assignmentId}`;
}

export function hasPendingAssistantToolUse(messages: MessageParam[]): boolean {
  const last = messages.at(-1);
  return Boolean(last && last.role === 'assistant' && Array.isArray(last.content) && last.content.some(block => block.type === 'tool_use'));
}

export function buildRuntimeMessages(messages: MessageParam[], protocol: TeamDelegationProtocol): MessageParam[] {
  const protocolMessage: MessageParam = { role: 'user', content: renderTeamDelegationProtocol(protocol) };
  const last = messages.at(-1);
  if (last?.role === 'assistant') {
    return [...messages.slice(0, -1), protocolMessage, last];
  }
  return [...messages, protocolMessage];
}

export function deriveAssignmentStatus(events: ExecuteTeamDelegatedRuntimeResult['events']): TeamAssignmentStatus {
  let status: TeamAssignmentStatus = 'running';
  for (const event of events) {
    if (event.type === 'approval_required') status = 'awaiting_approval';
    if (event.type === 'error') status = 'failed';
    if (event.type === 'done' && status === 'running' && event.stopReason !== 'max_turns') {
      status = event.stopReason === 'approval_required' ? 'awaiting_approval' : 'completed';
    }
  }
  return status;
}

export function buildRuntimeProtocol(
  input: ExecuteUnifiedTeamRuntimeInput,
  assignment: TeamRuntimeAssignmentInput,
  assignmentId: string,
): TeamDelegationProtocol {
  return assignment.delegation_protocol ?? buildTeamDelegationProtocol({
    assignment_id: assignmentId,
    workspace_id: input.workspaceId,
    task_id: assignment.task_id,
    task_kind: assignment.task_kind,
    owner_role: assignment.owner_role,
    delegate_role: assignment.delegate_role,
    delegate_id: assignment.delegate_id,
    coordination_policy: input.coordinationPolicy,
    stage: assignment.stage ?? 0,
    handoff_id: assignment.handoff_id ?? null,
    handoff_kind: assignment.handoff_kind ?? null,
    checkpoint_id: assignment.checkpoint_id ?? null,
    required_tools: input.tools.map(tool => tool.name),
  });
}

export function snapshotResult(
  state: TeamExecutionState,
  baseRunId: string,
  manager: TeamExecutionStateManager,
  assignment: TeamExecutionState['delegate_assignments'][number],
): TeamAssignmentExecutionResult {
  const delegatedRunId = runtimeRunId(baseRunId, assignment.assignment_id);
  return {
    assignment_id: assignment.assignment_id,
    task_id: assignment.task_id,
    stage: assignment.stage,
    status: assignment.status,
    delegation_protocol: assignment.delegation_protocol,
    runtime_run_id: delegatedRunId,
    events: [],
    last_completed_step: assignment.last_completed_step,
    manifest_path: `artifacts/runs/${delegatedRunId}/manifest.json`,
    resume_from: assignment.resume_from,
    resumed: Boolean(assignment.resume_from),
    skipped_step_ids: [],
    team_state: state,
    team_state_path: manager.pathFor(baseRunId),
  };
}
