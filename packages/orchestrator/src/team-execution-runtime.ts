import type { MessageParam, Tool } from './backends/chat-backend.js';
import { executeDelegatedAgentRuntime } from './research-loop/delegated-agent-runtime.js';
import type { ExecuteDelegatedAgentRuntimeInput } from './research-loop/delegated-agent-runtime.js';
import {
  createTeamExecutionState,
  registerDelegateAssignment,
  applyTeamIntervention,
  markTimedOutAssignments,
  recordHeartbeat,
  recordTeamCheckpoint,
  restoreTeamCheckpoint,
  updateDelegateAssignment,
} from './team-execution-state.js';
import { TeamExecutionStateManager } from './team-execution-storage.js';
import type {
  TeamCoordinationPolicy,
  TeamInterventionCommand,
  TeamPermissionMatrix,
} from './team-execution-types.js';
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

function deriveAssignmentStatus(events: ExecuteTeamDelegatedRuntimeResult['events']): {
  status: 'running' | 'awaiting_approval' | 'completed' | 'failed';
} {
  let status: 'running' | 'awaiting_approval' | 'completed' | 'failed' = 'running';
  for (const event of events) {
    if (event.type === 'approval_required') {
      status = 'awaiting_approval';
      continue;
    }
    if (event.type === 'error') {
      status = 'failed';
      continue;
    }
    if (event.type !== 'done' || status !== 'running') {
      continue;
    }
    if (event.stopReason === 'approval_required') {
      status = 'awaiting_approval';
      continue;
    }
    if (event.stopReason === 'max_turns') {
      continue;
    }
    status = 'completed';
  }
  return { status };
}

function ensureTeamAssignment(
  teamState: NonNullable<ReturnType<TeamExecutionStateManager['load']>>,
  input: ExecuteTeamDelegatedRuntimeInput,
) {
  const existing = teamState.delegate_assignments.find(
    assignment => assignment.task_id === input.taskId && assignment.delegate_id === input.delegateId,
  );
  if (existing) {
    return existing;
  }
  return registerDelegateAssignment(teamState, {
    owner_role: input.ownerRole,
    delegate_role: input.delegateRole,
    delegate_id: input.delegateId,
    task_id: input.taskId,
    task_kind: input.taskKind ?? 'compute',
    handoff_id: input.handoffId ?? null,
    handoff_kind: input.handoffKind ?? null,
    checkpoint_id: input.checkpointId ?? null,
  });
}

function shouldSuspendAssignment(
  status: NonNullable<ExecuteTeamDelegatedRuntimeResult['team_state']['delegate_assignments'][number]>['status'],
): boolean {
  return ['paused', 'cancelled', 'cascade_stopped', 'timed_out', 'awaiting_approval'].includes(status);
}

function suspendedResult(
  input: ExecuteTeamDelegatedRuntimeInput,
  assignment: NonNullable<ExecuteTeamDelegatedRuntimeResult['team_state']['delegate_assignments'][number]>,
  manager: TeamExecutionStateManager,
  teamState: ExecuteTeamDelegatedRuntimeResult['team_state'],
): ExecuteTeamDelegatedRuntimeResult {
  return {
    assignment_id: assignment.assignment_id,
    events: [],
    last_completed_step: assignment.last_completed_step,
    manifest_path: `artifacts/runs/${input.runId}/manifest.json`,
    resume_from: input.resumeFrom ?? assignment.resume_from,
    resumed: Boolean(input.resumeFrom ?? assignment.resume_from),
    skipped_step_ids: [],
    team_state: teamState,
    team_state_path: manager.pathFor(input.runId),
  };
}

export async function executeTeamDelegatedRuntime(
  input: ExecuteTeamDelegatedRuntimeInput,
): Promise<ExecuteTeamDelegatedRuntimeResult> {
  const manager = new TeamExecutionStateManager(input.projectRoot);
  let teamState = manager.load(input.runId);
  if (!teamState) {
    teamState = createTeamExecutionState({
      workspace_id: input.workspaceId,
      coordination_policy: input.coordinationPolicy,
      assignment: {
        owner_role: input.ownerRole,
        delegate_role: input.delegateRole,
        delegate_id: input.delegateId,
        task_id: input.taskId,
        task_kind: input.taskKind ?? 'compute',
        handoff_id: input.handoffId ?? null,
        handoff_kind: input.handoffKind ?? null,
        checkpoint_id: input.checkpointId ?? null,
      },
      permissions: input.permissions,
      interventions: input.interventions,
    }, input.runId);
  } else {
    for (const command of input.interventions ?? []) {
      applyTeamIntervention(teamState, command);
    }
  }
  const assignment = ensureTeamAssignment(teamState, input);
  if (shouldSuspendAssignment(assignment.status)) {
    manager.save(teamState);
    return suspendedResult(input, assignment, manager, teamState);
  }
  if (assignment.checkpoint_id) {
    restoreTeamCheckpoint(teamState, assignment.checkpoint_id);
  }
  const refreshedAssignment = teamState.delegate_assignments.find(item => item.assignment_id === assignment.assignment_id)!;
  if (shouldSuspendAssignment(refreshedAssignment.status)) {
    manager.save(teamState);
    return suspendedResult(input, refreshedAssignment, manager, teamState);
  }
  recordHeartbeat(teamState, refreshedAssignment.assignment_id);
  updateDelegateAssignment(teamState, refreshedAssignment.assignment_id, { status: 'running' });
  manager.save(teamState);

  const runtimeResult = await executeDelegatedAgentRuntime({
    projectRoot: input.projectRoot,
    runId: input.runId,
    model: input.model,
    messages: input.messages,
    tools: input.tools,
    mcpClient: input.mcpClient,
    approvalGate: input.approvalGate,
    resumeFrom: input.resumeFrom ?? refreshedAssignment.resume_from ?? undefined,
    maxTurns: input.maxTurns,
    routingConfig: input.routingConfig,
    spanCollector: input.spanCollector,
    backendFactory: input.backendFactory,
    _messagesCreate: input._messagesCreate,
  });

  const summary = deriveAssignmentStatus(runtimeResult.events);
  updateDelegateAssignment(teamState, refreshedAssignment.assignment_id, {
    status: summary.status,
    last_completed_step: runtimeResult.last_completed_step,
    resume_from: runtimeResult.resume_from,
  });
  recordHeartbeat(teamState, refreshedAssignment.assignment_id);
  if (runtimeResult.last_completed_step || refreshedAssignment.checkpoint_id) {
    recordTeamCheckpoint(teamState, {
      assignment_id: refreshedAssignment.assignment_id,
      checkpoint_id: refreshedAssignment.checkpoint_id ?? `team:${input.runId}:${refreshedAssignment.assignment_id}`,
      task_id: refreshedAssignment.task_id,
      handoff_id: refreshedAssignment.handoff_id,
      last_completed_step: runtimeResult.last_completed_step,
      resume_from: runtimeResult.resume_from,
    });
  }
  if (markTimedOutAssignments(teamState).length > 0) {
    recordHeartbeat(teamState, refreshedAssignment.assignment_id);
  }
  manager.save(teamState);

  return {
    assignment_id: assignment.assignment_id,
    events: runtimeResult.events,
    last_completed_step: runtimeResult.last_completed_step,
    manifest_path: runtimeResult.manifest_path,
    resume_from: runtimeResult.resume_from,
    resumed: runtimeResult.resumed,
    skipped_step_ids: runtimeResult.skipped_step_ids,
    team_state: teamState,
    team_state_path: manager.pathFor(input.runId),
  };
}
