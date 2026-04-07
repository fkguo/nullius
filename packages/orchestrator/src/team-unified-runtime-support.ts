import type { MessageParam } from './backends/chat-backend.js';
import { asMcpError, type AgentEvent } from './agent-runner-ops.js';
import { isTerminalCompletionStopReason } from './agent-runner-stop-reasons.js';
import {
  buildTeamDelegationProtocol,
  renderTeamDelegationProtocol,
  type TeamDelegationProtocol,
} from './delegation-protocol.js';
import {
  executeDelegatedAgentRuntime,
  type ExecuteDelegatedAgentRuntimeResult,
} from './research-loop/delegated-agent-runtime.js';
import type { DelegatedRuntimeHandleV1 } from './delegated-runtime-handle.js';
import {
  buildDelegatedExecutionIdentity,
  delegatedExecutionManifestPath,
} from './execution-identity.js';
import { renderPendingRedirect } from './team-execution-intervention-payloads.js';
import { compileDelegatedRuntimePermissionProfile } from './team-execution-permissions.js';
import {
  isTerminalAssignmentStatus,
  markTimedOutAssignments,
  recordHeartbeat,
  recordTeamCheckpoint,
  restoreTeamCheckpoint,
  updateDelegateAssignment,
} from './team-execution-assignment-state.js';
import {
  finalizeAssignmentSession,
  normalizeTeamScopingState,
  openAssignmentSession,
} from './team-execution-scoping.js';
import { appendTeamEvent } from './team-execution-events.js';
import { TeamExecutionStateManager } from './team-execution-storage.js';
import type { TeamAssignmentStatus, TeamExecutionState } from './team-execution-types.js';
import type {
  ExecuteUnifiedTeamRuntimeInput,
  TeamAssignmentExecutionResult,
  TeamRuntimeAssignmentInput,
} from './team-unified-runtime-types.js';
import { utcNowIso } from './util.js';

export function hasPendingAssistantToolUse(messages: MessageParam[]): boolean {
  const last = messages.at(-1);
  return Boolean(
    last
      && last.role === 'assistant'
      && Array.isArray(last.content)
      && last.content.some(block => block.type === 'tool_use'),
  );
}

function scopeAssistantResumeMessage(
  messages: MessageParam[],
  taskId: TeamDelegationProtocol['TASK']['task_id'],
): MessageParam[] {
  const last = messages.at(-1);
  if (!last || last.role !== 'assistant' || !Array.isArray(last.content)) {
    return messages;
  }
  const hasToolUse = last.content.some(block => block.type === 'tool_use');
  if (!hasToolUse) {
    return messages;
  }
  const scopedContent = last.content.filter(block => block.type !== 'tool_use'
    || typeof block.input !== 'object'
    || block.input === null
    || !('task_id' in block.input)
    || block.input.task_id === taskId);
  if (scopedContent.length === last.content.length) {
    return messages;
  }
  if (scopedContent.length === 0) {
    return messages.slice(0, -1);
  }
  return [...messages.slice(0, -1), { ...last, content: scopedContent }];
}

function pendingResumeStepId(
  messages: MessageParam[],
  taskId: TeamExecutionState['delegate_assignments'][number]['task_id'],
): string | undefined {
  const last = messages.at(-1);
  if (!last || last.role !== 'assistant' || !Array.isArray(last.content)) {
    return undefined;
  }
  const toolUse = last.content.find((block): block is Extract<typeof last.content[number], { type: 'tool_use' }> =>
    block.type === 'tool_use'
    && typeof block.input === 'object'
    && block.input !== null
    && 'task_id' in block.input
    && block.input.task_id === taskId,
  );
  return toolUse?.id;
}

export function buildRuntimeMessages(
  messages: MessageParam[],
  protocol: TeamDelegationProtocol,
  pendingRedirect: TeamExecutionState['delegate_assignments'][number]['pending_redirect'],
): MessageParam[] {
  const scopedMessages = scopeAssistantResumeMessage(messages, protocol.TASK.task_id);
  const protocolMessage: MessageParam = { role: 'user', content: renderTeamDelegationProtocol(protocol) };
  const redirectMessageText = renderPendingRedirect(pendingRedirect);
  const redirectMessage = redirectMessageText ? [{ role: 'user' as const, content: redirectMessageText }] : [];
  const last = scopedMessages.at(-1);
  if (last?.role === 'assistant') {
    return [...scopedMessages.slice(0, -1), protocolMessage, ...redirectMessage, last];
  }
  return [...scopedMessages, protocolMessage, ...redirectMessage];
}

function resolveAssignmentResumeFrom(
  input: ExecuteUnifiedTeamRuntimeInput,
  assignment: TeamExecutionState['delegate_assignments'][number],
): string | undefined {
  return input.resumeFrom
    ?? assignment.resume_from
    ?? assignment.last_completed_step
    ?? pendingResumeStepId(input.messages, assignment.task_id)
    ?? undefined;
}

function approvalMetadataFromEvents(events: AgentEvent[]): {
  approval_id: string;
  approval_packet_path: string;
  approval_requested_at: string;
} | null {
  const event = events.find((item): item is Extract<AgentEvent, { type: 'approval_required' }> => item.type === 'approval_required');
  if (!event) return null;
  return {
    approval_id: event.approvalId,
    approval_packet_path: event.packetPath,
    approval_requested_at: utcNowIso(),
  };
}

export function deriveAssignmentStatus(
  runtimeResult: Pick<ExecuteDelegatedAgentRuntimeResult, 'events' | 'last_completed_step' | 'resume_from'>,
  current: Pick<TeamExecutionState['delegate_assignments'][number], 'checkpoint_id' | 'resume_from'>,
): TeamAssignmentStatus {
  let status: TeamAssignmentStatus = 'running';
  for (const event of runtimeResult.events) {
    if (event.type === 'approval_required') status = 'awaiting_approval';
    if (event.type === 'done' && status === 'running') {
      if (event.stopReason === 'approval_required') status = 'awaiting_approval';
      if (event.stopReason === 'diminishing_returns') status = 'needs_recovery';
      if (isTerminalCompletionStopReason(event.stopReason)) status = 'completed';
    }
  }
  if (status !== 'running') return status;
  const errored = runtimeResult.events.some(event => event.type === 'error');
  if (!errored) return status;
  return runtimeResult.last_completed_step || runtimeResult.resume_from || current.checkpoint_id || current.resume_from
    ? 'needs_recovery'
    : 'failed';
}

function isSuspended(status: TeamAssignmentStatus): boolean {
  return ['paused', 'awaiting_approval', 'timed_out', 'cancelled', 'cascade_stopped'].includes(status);
}

export function buildRuntimeProtocol(
  input: ExecuteUnifiedTeamRuntimeInput,
  state: TeamExecutionState,
  assignment: TeamRuntimeAssignmentInput,
  assignmentId: string,
): TeamDelegationProtocol {
  const permissionProfile = compileDelegatedRuntimePermissionProfile(
    input.permissions,
    assignment,
    input.tools,
    state,
  );
  const baseProtocol = assignment.delegation_protocol ?? buildTeamDelegationProtocol({
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
    required_tools: permissionProfile.tools.allowed_tool_names,
  });

  return {
    ...baseProtocol,
    TASK: {
      ...baseProtocol.TASK,
      assignment_id: assignmentId,
      task_id: assignment.task_id,
      task_kind: assignment.task_kind,
      owner_role: assignment.owner_role,
      delegate_role: assignment.delegate_role,
      delegate_id: assignment.delegate_id,
      stage: assignment.stage ?? 0,
    },
    REQUIRED_TOOLS: { tool_names: [...permissionProfile.tools.allowed_tool_names] },
    CONTEXT: {
      ...baseProtocol.CONTEXT,
      workspace_id: input.workspaceId,
      coordination_policy: input.coordinationPolicy,
      handoff_id: assignment.handoff_id ?? null,
      checkpoint_id: assignment.checkpoint_id ?? null,
    },
  };
}

export function snapshotResult(
  state: TeamExecutionState,
  baseRunId: string,
  manager: TeamExecutionStateManager,
  assignment: TeamExecutionState['delegate_assignments'][number],
): TeamAssignmentExecutionResult {
  // Snapshot paths reuse deterministic identity derivation because they can be
  // reached without producing a fresh launch handle in this invocation.
  const execution = buildDelegatedExecutionIdentity({
    project_run_id: baseRunId,
    assignment_id: assignment.assignment_id,
  });
  return {
    assignment_id: assignment.assignment_id,
    task_id: assignment.task_id,
    stage: assignment.stage,
    status: assignment.status,
    delegation_protocol: assignment.delegation_protocol,
    runtime_run_id: execution.runtime_run_id,
    events: [],
    last_completed_step: assignment.last_completed_step,
    manifest_path: delegatedExecutionManifestPath(execution),
    resume_from: assignment.resume_from,
    resumed: Boolean(assignment.resume_from),
    skipped_step_ids: [],
    team_state: state,
    team_state_path: manager.pathFor(baseRunId),
  };
}

type RuntimeBucket = {
  stage: number;
  assignments: TeamExecutionState['delegate_assignments'][number][];
  concurrent: boolean;
};

type SnapshotOutcome = {
  kind: 'snapshot';
  assignmentId: string;
  result: TeamAssignmentExecutionResult;
};

type PendingLaunch = {
  kind: 'launch';
  assignmentId: string;
  handle: DelegatedRuntimeHandleV1;
};

type LaunchOutcome = {
  assignmentId: string;
  handle: DelegatedRuntimeHandleV1;
  runtimeResult?: ExecuteDelegatedAgentRuntimeResult;
  error?: AgentEvent & { type: 'error' };
};

export function buildRuntimeBuckets(
  coordinationPolicy: ExecuteUnifiedTeamRuntimeInput['coordinationPolicy'],
  assignments: TeamExecutionState['delegate_assignments'],
): RuntimeBucket[] {
  if (coordinationPolicy === 'parallel') {
    return [{ stage: assignments[0]?.stage ?? 0, assignments, concurrent: true }];
  }
  if (coordinationPolicy === 'stage_gated') {
    return Array.from(new Set(assignments.map(item => item.stage))).map(stage => ({
      stage,
      assignments: assignments.filter(item => item.stage === stage),
      concurrent: true,
    }));
  }
  // Sequential now owns its own explicit multi-assignment path, so the
  // remaining serial fallback is reserved for supervised_delegate.
  return assignments.map((assignment, index) => ({
    stage: assignment.stage ?? index,
    assignments: [assignment],
    concurrent: false,
  }));
}

function prepareAssignmentOutcome(
  input: ExecuteUnifiedTeamRuntimeInput,
  state: TeamExecutionState,
  manager: TeamExecutionStateManager,
  assignment: TeamExecutionState['delegate_assignments'][number],
  resumeRequested: boolean,
): SnapshotOutcome | PendingLaunch {
  const current = state.delegate_assignments.find(item => item.assignment_id === assignment.assignment_id)!;
  if (isTerminalAssignmentStatus(current.status) || isSuspended(current.status)) {
    return {
      kind: 'snapshot',
      assignmentId: current.assignment_id,
      result: snapshotResult(state, input.runId, manager, current),
    };
  }
  if (current.checkpoint_id && (current.status === 'needs_recovery' || resumeRequested)) {
    restoreTeamCheckpoint(state, current.checkpoint_id);
  }
  const refreshed = state.delegate_assignments.find(item => item.assignment_id === assignment.assignment_id)!;
  if (isTerminalAssignmentStatus(refreshed.status) || isSuspended(refreshed.status)) {
    return {
      kind: 'snapshot',
      assignmentId: refreshed.assignment_id,
      result: snapshotResult(state, input.runId, manager, refreshed),
    };
  }
  updateDelegateAssignment(state, refreshed.assignment_id, { status: 'running' });
  recordHeartbeat(state, refreshed.assignment_id);
  const running = state.delegate_assignments.find(item => item.assignment_id === assignment.assignment_id)!;
  const { handle } = openAssignmentSession(
    state,
    input.runId,
    running,
    resolveAssignmentResumeFrom(input, running) ?? null,
  );
  appendTeamEvent(state, { kind: 'assignment_started', assignment: running, payload: { stage: running.stage } });
  return {
    kind: 'launch',
    assignmentId: running.assignment_id,
    handle,
  };
}

async function executeLaunch(
  input: ExecuteUnifiedTeamRuntimeInput,
  state: TeamExecutionState,
  launch: PendingLaunch,
): Promise<LaunchOutcome> {
  const assignment = state.delegate_assignments.find(item => item.assignment_id === launch.assignmentId)!;
  const permissionProfile = compileDelegatedRuntimePermissionProfile(
    input.permissions,
    assignment,
    input.tools,
    state,
  );
  try {
    const runtimeResult = await executeDelegatedAgentRuntime({
      projectRoot: input.projectRoot,
      runId: launch.handle.identity.runtime_run_id,
      model: input.model,
      messages: buildRuntimeMessages(input.messages, assignment.delegation_protocol, assignment.pending_redirect),
      tools: input.tools,
      mcpClient: input.mcpClient,
      permissionProfile,
      delegated_runtime_handle: launch.handle,
      approvalGate: input.approvalGate,
      resumeFrom: resolveAssignmentResumeFrom(input, assignment),
      maxTurns: input.maxTurns,
      routingConfig: input.routingConfig,
      spanCollector: input.spanCollector,
      backendFactory: input.backendFactory,
      _messagesCreate: input._messagesCreate,
    });
    return { assignmentId: launch.assignmentId, handle: launch.handle, runtimeResult };
  } catch (error) {
    return {
      assignmentId: launch.assignmentId,
      handle: launch.handle,
      error: { type: 'error', error: asMcpError(error, 'Delegated runtime failed: ') },
    };
  }
}

function mergeLaunchOutcome(
  input: ExecuteUnifiedTeamRuntimeInput,
  state: TeamExecutionState,
  manager: TeamExecutionStateManager,
  launch: LaunchOutcome,
): TeamAssignmentExecutionResult {
  const current = state.delegate_assignments.find(item => item.assignment_id === launch.assignmentId)!;
  if (launch.error) {
    const status: TeamAssignmentStatus = current.checkpoint_id || current.last_completed_step || current.resume_from
      ? 'needs_recovery'
      : 'failed';
    updateDelegateAssignment(state, current.assignment_id, {
      status,
      ...(status === 'failed'
        ? {
            pending_redirect: null,
            approval_id: null,
            approval_packet_path: null,
            approval_requested_at: null,
          }
        : {}),
    });
    const updated = state.delegate_assignments.find(item => item.assignment_id === current.assignment_id)!;
    const session = finalizeAssignmentSession(state, updated);
    if (session) {
      session.runtime_projection = null;
    }
    appendTeamEvent(state, {
      kind: 'assignment_status_changed',
      assignment: updated,
      payload: {
        stage: updated.stage,
        status,
        runtime_run_id: launch.handle.identity.runtime_run_id,
        error: launch.error.error.message,
      },
    });
    recordHeartbeat(state, updated.assignment_id);
    manager.save(state);
    return {
      assignment_id: updated.assignment_id,
      task_id: updated.task_id,
      stage: updated.stage,
      status: updated.status,
      delegation_protocol: updated.delegation_protocol,
      runtime_run_id: launch.handle.identity.runtime_run_id,
      events: [launch.error],
      last_completed_step: updated.last_completed_step,
      manifest_path: launch.handle.artifacts.manifest_path,
      resume_from: updated.resume_from,
      resumed: Boolean(updated.resume_from),
      skipped_step_ids: [],
      team_state: state,
      team_state_path: manager.pathFor(input.runId),
    };
  }
  const runtimeResult = launch.runtimeResult!;
  const status = deriveAssignmentStatus(runtimeResult, current);
  const approval = status === 'awaiting_approval'
    ? approvalMetadataFromEvents(runtimeResult.events)
    : null;
  updateDelegateAssignment(state, current.assignment_id, {
    status,
    last_completed_step: runtimeResult.last_completed_step,
    resume_from: runtimeResult.resume_from,
    approval_id: approval?.approval_id ?? null,
    approval_packet_path: approval?.approval_packet_path ?? null,
    approval_requested_at: approval?.approval_requested_at ?? null,
    pending_redirect: null,
  });
  const updated = state.delegate_assignments.find(item => item.assignment_id === current.assignment_id)!;
  appendTeamEvent(state, {
    kind: 'assignment_status_changed',
    assignment: updated,
    payload: { stage: updated.stage, status, runtime_run_id: launch.handle.identity.runtime_run_id },
  });
  recordHeartbeat(state, updated.assignment_id);
  if (runtimeResult.last_completed_step || updated.checkpoint_id) {
    recordTeamCheckpoint(state, {
      assignment_id: updated.assignment_id,
      checkpoint_id: updated.checkpoint_id ?? `team:${input.runId}:${updated.assignment_id}`,
      task_id: updated.task_id,
      handoff_id: updated.handoff_id,
      last_completed_step: runtimeResult.last_completed_step,
      resume_from: runtimeResult.resume_from,
    });
  }
  const session = finalizeAssignmentSession(state, updated);
  if (session) {
    session.runtime_projection = runtimeResult.runtime_projection;
  }
  manager.save(state);
  return {
    assignment_id: updated.assignment_id,
    task_id: updated.task_id,
    stage: updated.stage,
    status: updated.status,
    delegation_protocol: updated.delegation_protocol,
    runtime_run_id: launch.handle.identity.runtime_run_id,
    events: runtimeResult.events,
    last_completed_step: runtimeResult.last_completed_step,
    manifest_path: runtimeResult.manifest_path,
    resume_from: runtimeResult.resume_from,
    resumed: runtimeResult.resumed,
    skipped_step_ids: runtimeResult.skipped_step_ids,
    team_state: state,
    team_state_path: manager.pathFor(input.runId),
  };
}

export async function executeRuntimeBucket(
  input: ExecuteUnifiedTeamRuntimeInput,
  state: TeamExecutionState,
  manager: TeamExecutionStateManager,
  bucket: RuntimeBucket,
): Promise<TeamAssignmentExecutionResult[]> {
  const resumeRequested = Boolean(input.resumeFrom) || hasPendingAssistantToolUse(input.messages);
  normalizeTeamScopingState(state, input.runId);
  const timedOutBeforeLaunch = markTimedOutAssignments(state);
  timedOutBeforeLaunch.forEach(assignment => finalizeAssignmentSession(state, assignment));
  const prepared = bucket.assignments.map(assignment =>
    prepareAssignmentOutcome(input, state, manager, assignment, resumeRequested),
  );
  manager.save(state);
  const pendingLaunches = prepared.filter((item): item is PendingLaunch => item.kind === 'launch');
  const outcomes = bucket.concurrent
    ? await Promise.all(pendingLaunches.map(item => executeLaunch(input, state, item)))
    : await pendingLaunches.reduce<Promise<LaunchOutcome[]>>(async (promise, item) => {
      const collected = await promise;
      collected.push(await executeLaunch(input, state, item));
      return collected;
    }, Promise.resolve([]));
  const outcomeByAssignmentId = new Map(outcomes.map(outcome => [outcome.assignmentId, outcome]));
  const results = prepared.map(item => item.kind === 'snapshot'
    ? item.result
    : mergeLaunchOutcome(input, state, manager, outcomeByAssignmentId.get(item.assignmentId)!));
  const timedOutAfterMerge = markTimedOutAssignments(state);
  timedOutAfterMerge.forEach(assignment => finalizeAssignmentSession(state, assignment));
  manager.save(state);
  return results.map(result => {
    const current = state.delegate_assignments.find(item => item.assignment_id === result.assignment_id);
    if (!current || current.status === result.status) {
      return result;
    }
    return { ...result, status: current.status, team_state: state, team_state_path: manager.pathFor(input.runId) };
  });
}
