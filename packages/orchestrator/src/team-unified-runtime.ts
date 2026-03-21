import { randomUUID } from 'node:crypto';
import { appendTeamEvent } from './team-execution-events.js';
import { executeDelegatedAgentRuntime } from './research-loop/delegated-agent-runtime.js';
import {
  applyTeamIntervention,
  createTeamExecutionState,
  markTimedOutAssignments,
  recordHeartbeat,
  recordTeamCheckpoint,
  registerDelegateAssignment,
  restoreTeamCheckpoint,
  updateDelegateAssignment,
} from './team-execution-state.js';
import { TeamExecutionStateManager } from './team-execution-storage.js';
import { buildTeamControlPlaneView } from './team-execution-view.js';
import {
  buildRuntimeMessages,
  buildRuntimeProtocol,
  deriveAssignmentStatus,
  hasPendingAssistantToolUse,
  runtimeRunId,
  snapshotResult,
} from './team-unified-runtime-support.js';
import type {
  TeamAssignmentStatus,
  TeamExecutionState,
} from './team-execution-types.js';
import { isTerminalAssignmentStatus } from './team-execution-assignment-state.js';
import type {
  ExecuteUnifiedTeamRuntimeInput,
  ExecuteUnifiedTeamRuntimeResult,
  TeamAssignmentExecutionResult,
  TeamRuntimeAssignmentInput,
} from './team-unified-runtime-types.js';

export type {
  ExecuteUnifiedTeamRuntimeInput,
  ExecuteUnifiedTeamRuntimeResult,
  TeamAssignmentExecutionResult,
  TeamRuntimeAssignmentInput,
} from './team-unified-runtime-types.js';

function ensureAssignmentRegistration(
  state: TeamExecutionState,
  input: ExecuteUnifiedTeamRuntimeInput,
  assignment: TeamRuntimeAssignmentInput & { assignment_id: string },
): TeamExecutionState['delegate_assignments'][number] {
  const existing = state.delegate_assignments.find(candidate =>
    candidate.task_id === assignment.task_id
    && candidate.delegate_id === assignment.delegate_id
    && candidate.stage === (assignment.stage ?? 0)
    && candidate.task_kind === assignment.task_kind
    && candidate.owner_role === assignment.owner_role
    && candidate.delegate_role === assignment.delegate_role
    && candidate.handoff_id === (assignment.handoff_id ?? null)
    && candidate.handoff_kind === (assignment.handoff_kind ?? null)
  );
  if (existing) return existing;
  return registerDelegateAssignment(state, {
    ...assignment,
    delegation_protocol: buildRuntimeProtocol(input, assignment, assignment.assignment_id),
  });
}

function isSuspended(status: TeamAssignmentStatus): boolean {
  return ['paused', 'awaiting_approval', 'timed_out', 'cancelled', 'cascade_stopped'].includes(status);
}

async function executeAssignment(
  input: ExecuteUnifiedTeamRuntimeInput,
  state: TeamExecutionState,
  manager: TeamExecutionStateManager,
  assignment: TeamExecutionState['delegate_assignments'][number],
): Promise<TeamAssignmentExecutionResult> {
  const resumeRequested = Boolean(input.resumeFrom) || hasPendingAssistantToolUse(input.messages);
  if ((isTerminalAssignmentStatus(assignment.status) && !resumeRequested) || isSuspended(assignment.status)) {
    manager.save(state);
    return snapshotResult(state, input.runId, manager, assignment);
  }
  if (assignment.checkpoint_id) restoreTeamCheckpoint(state, assignment.checkpoint_id);
  const current = state.delegate_assignments.find(item => item.assignment_id === assignment.assignment_id)!;
  if (isSuspended(current.status)) {
    manager.save(state);
    return snapshotResult(state, input.runId, manager, current);
  }
  updateDelegateAssignment(state, current.assignment_id, { status: 'running' });
  recordHeartbeat(state, current.assignment_id);
  appendTeamEvent(state, { kind: 'assignment_started', assignment: current, payload: { stage: current.stage } });
  manager.save(state);

  const delegatedRunId = runtimeRunId(input.runId, current.assignment_id);
  const runtimeResult = await executeDelegatedAgentRuntime({
    projectRoot: input.projectRoot,
    runId: delegatedRunId,
    model: input.model,
    messages: buildRuntimeMessages(input.messages, current.delegation_protocol),
    tools: input.tools,
    mcpClient: input.mcpClient,
    approvalGate: input.approvalGate,
    resumeFrom: input.resumeFrom ?? current.resume_from ?? undefined,
    maxTurns: input.maxTurns,
    routingConfig: input.routingConfig,
    spanCollector: input.spanCollector,
    backendFactory: input.backendFactory,
    _messagesCreate: input._messagesCreate,
  });

  const status = deriveAssignmentStatus(runtimeResult.events);
  updateDelegateAssignment(state, current.assignment_id, {
    status,
    last_completed_step: runtimeResult.last_completed_step,
    resume_from: runtimeResult.resume_from,
  });
  const updated = state.delegate_assignments.find(item => item.assignment_id === current.assignment_id)!;
  appendTeamEvent(state, {
    kind: 'assignment_status_changed',
    assignment: updated,
    payload: { stage: updated.stage, status, runtime_run_id: delegatedRunId },
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
  markTimedOutAssignments(state);
  manager.save(state);
  return {
    ...runtimeResult,
    assignment_id: updated.assignment_id,
    task_id: updated.task_id,
    stage: updated.stage,
    status: updated.status,
    delegation_protocol: updated.delegation_protocol,
    runtime_run_id: delegatedRunId,
    team_state: state,
    team_state_path: manager.pathFor(input.runId),
  };
}

export async function executeUnifiedTeamRuntime(
  input: ExecuteUnifiedTeamRuntimeInput,
): Promise<ExecuteUnifiedTeamRuntimeResult> {
  const manager = new TeamExecutionStateManager(input.projectRoot);
  const preparedAssignments = input.assignments.map(assignment => ({
    ...assignment,
    assignment_id: assignment.assignment_id ?? randomUUID(),
  }));
  const [headAssignment] = preparedAssignments;
  if (!headAssignment) throw new Error('team runtime requires at least one assignment');
  const state = manager.load(input.runId) ?? createTeamExecutionState({
    workspace_id: input.workspaceId,
    coordination_policy: input.coordinationPolicy,
    assignment: {
      ...headAssignment,
      delegation_protocol: buildRuntimeProtocol(input, headAssignment, headAssignment.assignment_id),
    },
    permissions: input.permissions,
  }, input.runId);
  state.blocked_stage ??= null;
  state.event_log ??= [];
  const ensuredAssignments = preparedAssignments.map(assignment => ensureAssignmentRegistration(state, input, assignment));
  for (const command of input.interventions ?? []) applyTeamIntervention(state, command);
  // A fresh invocation is the explicit signal to retry any previously blocked stage.
  state.blocked_stage = null;
  manager.save(state);

  const orderedAssignments = [...ensuredAssignments].sort((left, right) => left.stage - right.stage);
  const stageBuckets = input.coordinationPolicy === 'stage_gated'
    ? Array.from(new Set(orderedAssignments.map(item => item.stage))).map(stage => ({
        stage,
        assignments: orderedAssignments.filter(item => item.stage === stage),
      }))
    : orderedAssignments.map((assignment, index) => ({ stage: assignment.stage ?? index, assignments: [assignment] }));

  const assignmentResults: TeamAssignmentExecutionResult[] = [];
  for (const bucket of stageBuckets) {
    if (input.coordinationPolicy === 'stage_gated') {
      appendTeamEvent(state, { kind: 'stage_started', payload: { stage: bucket.stage, assignment_count: bucket.assignments.length } });
    }
    const stageResults: TeamAssignmentExecutionResult[] = [];
    for (const assignment of bucket.assignments) stageResults.push(await executeAssignment(input, state, manager, assignment));
    assignmentResults.push(...stageResults);
    if (input.coordinationPolicy !== 'stage_gated') continue;
    if (stageResults.some(result => result.status !== 'completed')) {
      state.blocked_stage = bucket.stage;
      appendTeamEvent(state, { kind: 'stage_blocked', payload: { stage: bucket.stage } });
      manager.save(state);
      break;
    }
    appendTeamEvent(state, { kind: 'stage_completed', payload: { stage: bucket.stage } });
    manager.save(state);
  }

  const { live_status, replay } = buildTeamControlPlaneView(state);
  return {
    assignment_results: assignmentResults,
    blocked_stage: state.blocked_stage,
    team_state: state,
    team_state_path: manager.pathFor(input.runId),
    live_status,
    replay,
  };
}
