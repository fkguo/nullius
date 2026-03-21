import type { MessageParam } from './backends/chat-backend.js';
import { asMcpError, type AgentEvent } from './agent-runner-ops.js';
import {
  buildTeamDelegationProtocol,
  renderTeamDelegationProtocol,
  type TeamDelegationProtocol,
} from './delegation-protocol.js';
import {
  executeDelegatedAgentRuntime,
  type ExecuteDelegatedAgentRuntimeResult,
} from './research-loop/delegated-agent-runtime.js';
import { renderPendingRedirect } from './team-execution-intervention-payloads.js';
import {
  isTerminalAssignmentStatus,
  markTimedOutAssignments,
  recordHeartbeat,
  recordTeamCheckpoint,
  restoreTeamCheckpoint,
  updateDelegateAssignment,
} from './team-execution-assignment-state.js';
import { appendTeamEvent } from './team-execution-events.js';
import { TeamExecutionStateManager } from './team-execution-storage.js';
import type { TeamAssignmentStatus, TeamExecutionState } from './team-execution-types.js';
import type {
  ExecuteUnifiedTeamRuntimeInput,
  TeamAssignmentExecutionResult,
  TeamRuntimeAssignmentInput,
} from './team-unified-runtime-types.js';
import { utcNowIso } from './util.js';

export function runtimeRunId(runId: string, assignmentId: string): string {
  return `${runId}__${assignmentId}`;
}

export function hasPendingAssistantToolUse(messages: MessageParam[]): boolean {
  const last = messages.at(-1);
  return Boolean(
    last
      && last.role === 'assistant'
      && Array.isArray(last.content)
      && last.content.some(block => block.type === 'tool_use'),
  );
}

export function buildRuntimeMessages(
  messages: MessageParam[],
  protocol: TeamDelegationProtocol,
  pendingRedirect: TeamExecutionState['delegate_assignments'][number]['pending_redirect'],
): MessageParam[] {
  const protocolMessage: MessageParam = { role: 'user', content: renderTeamDelegationProtocol(protocol) };
  const redirectMessageText = renderPendingRedirect(pendingRedirect);
  const redirectMessage = redirectMessageText ? [{ role: 'user' as const, content: redirectMessageText }] : [];
  const last = messages.at(-1);
  if (last?.role === 'assistant') {
    return [...messages.slice(0, -1), protocolMessage, ...redirectMessage, last];
  }
  return [...messages, protocolMessage, ...redirectMessage];
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
    if (event.type === 'done' && status === 'running' && event.stopReason !== 'max_turns') {
      status = event.stopReason === 'approval_required' ? 'awaiting_approval' : 'completed';
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
  delegatedRunId: string;
};

type LaunchOutcome = {
  assignmentId: string;
  delegatedRunId: string;
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
  appendTeamEvent(state, { kind: 'assignment_started', assignment: running, payload: { stage: running.stage } });
  return {
    kind: 'launch',
    assignmentId: running.assignment_id,
    delegatedRunId: runtimeRunId(input.runId, running.assignment_id),
  };
}

async function executeLaunch(
  input: ExecuteUnifiedTeamRuntimeInput,
  state: TeamExecutionState,
  launch: PendingLaunch,
): Promise<LaunchOutcome> {
  const assignment = state.delegate_assignments.find(item => item.assignment_id === launch.assignmentId)!;
  try {
    const runtimeResult = await executeDelegatedAgentRuntime({
      projectRoot: input.projectRoot,
      runId: launch.delegatedRunId,
      model: input.model,
      messages: buildRuntimeMessages(input.messages, assignment.delegation_protocol, assignment.pending_redirect),
      tools: input.tools,
      mcpClient: input.mcpClient,
      approvalGate: input.approvalGate,
      resumeFrom: input.resumeFrom ?? assignment.resume_from ?? undefined,
      maxTurns: input.maxTurns,
      routingConfig: input.routingConfig,
      spanCollector: input.spanCollector,
      backendFactory: input.backendFactory,
      _messagesCreate: input._messagesCreate,
    });
    return { assignmentId: launch.assignmentId, delegatedRunId: launch.delegatedRunId, runtimeResult };
  } catch (error) {
    return {
      assignmentId: launch.assignmentId,
      delegatedRunId: launch.delegatedRunId,
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
    updateDelegateAssignment(state, current.assignment_id, { status });
    const updated = state.delegate_assignments.find(item => item.assignment_id === current.assignment_id)!;
    appendTeamEvent(state, {
      kind: 'assignment_status_changed',
      assignment: updated,
      payload: {
        stage: updated.stage,
        status,
        runtime_run_id: launch.delegatedRunId,
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
      runtime_run_id: launch.delegatedRunId,
      events: [launch.error],
      last_completed_step: updated.last_completed_step,
      manifest_path: `artifacts/runs/${launch.delegatedRunId}/manifest.json`,
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
    payload: { stage: updated.stage, status, runtime_run_id: launch.delegatedRunId },
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
  manager.save(state);
  return {
    ...runtimeResult,
    assignment_id: updated.assignment_id,
    task_id: updated.task_id,
    stage: updated.stage,
    status: updated.status,
    delegation_protocol: updated.delegation_protocol,
    runtime_run_id: launch.delegatedRunId,
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
  markTimedOutAssignments(state);
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
  markTimedOutAssignments(state);
  manager.save(state);
  return results.map(result => {
    const current = state.delegate_assignments.find(item => item.assignment_id === result.assignment_id);
    if (!current || current.status === result.status) {
      return result;
    }
    return { ...result, status: current.status, team_state: state, team_state_path: manager.pathFor(input.runId) };
  });
}
