import { randomUUID } from 'node:crypto';
import { buildDelegatedExecutionIdentity } from './execution-identity.js';
import {
  projectResearchTaskStatusFromLifecycle,
  type ResearchTaskLifecycleProjection,
} from './research-loop/task-types.js';
import type {
  TeamAssignmentSession,
  TeamAssignmentStatus,
  TeamDelegateAssignment,
  TeamExecutionState,
  TeamMcpToolInheritance,
  TeamPendingApproval,
} from './team-execution-types.js';
import { utcNowIso } from './util.js';

export function runtimeRunId(runId: string, assignmentId: string): string {
  return buildDelegatedExecutionIdentity({
    project_run_id: runId,
    assignment_id: assignmentId,
  }).runtime_run_id;
}

export function taskLifecycleFromAssignmentStatus(
  status: TeamAssignmentStatus,
): ResearchTaskLifecycleProjection {
  switch (status) {
    case 'pending':
      return 'pending';
    case 'running':
    case 'paused':
    case 'awaiting_approval':
    case 'needs_recovery':
      return 'running';
    case 'completed':
      return 'completed';
    case 'failed':
    case 'timed_out':
      return 'failed';
    case 'cancelled':
    case 'cascade_stopped':
      return 'killed';
  }
}

function pendingApprovalFromAssignment(
  runId: string,
  assignment: TeamDelegateAssignment,
): TeamPendingApproval | null {
  if (!assignment.approval_id || !assignment.approval_packet_path || !assignment.approval_requested_at) {
    return null;
  }
  if (
    assignment.status !== 'awaiting_approval'
    && !(assignment.status === 'paused' && assignment.paused_from_status === 'awaiting_approval')
  ) {
    return null;
  }
  const execution = buildDelegatedExecutionIdentity({
    project_run_id: runId,
    assignment_id: assignment.assignment_id,
  });
  return {
    approval_id: assignment.approval_id,
    agent_id: assignment.delegate_id,
    assignment_id: assignment.assignment_id,
    session_id: assignment.session_id,
    runtime_run_id: execution.runtime_run_id,
    packet_path: assignment.approval_packet_path,
    requested_at: assignment.approval_requested_at,
  };
}

function syntheticSession(assignment: TeamDelegateAssignment, runId: string): TeamAssignmentSession {
  const lifecycle = taskLifecycleFromAssignmentStatus(assignment.status);
  const execution = buildDelegatedExecutionIdentity({
    project_run_id: runId,
    assignment_id: assignment.assignment_id,
  });
  return {
    session_id: assignment.session_id!,
    parent_session_id: null,
    context_kind: 'synthetic',
    agent_id: assignment.delegate_id,
    assignment_id: assignment.assignment_id,
    runtime_run_id: execution.runtime_run_id,
    runtime_status: assignment.status,
    task_lifecycle_status: lifecycle,
    task_status: projectResearchTaskStatusFromLifecycle(lifecycle),
    started_at: assignment.updated_at,
    ended_at: assignment.status === 'running' ? null : assignment.updated_at,
    checkpoint_id: assignment.checkpoint_id,
    last_completed_step: assignment.last_completed_step,
    resume_from: assignment.resume_from,
    forked_from_assignment_id: assignment.forked_from_assignment_id,
    forked_from_session_id: assignment.forked_from_session_id,
  };
}

export function normalizeTeamScopingState(state: TeamExecutionState, runId: string): void {
  state.pending_approvals ??= [];
  state.sessions ??= [];
  for (const assignment of state.delegate_assignments) {
    assignment.session_id ??= null;
    assignment.forked_from_assignment_id ??= null;
    assignment.forked_from_session_id ??= null;
    assignment.mcp_tool_inheritance ??= { mode: 'team_permission_matrix' };
    const inheritance = assignment.mcp_tool_inheritance as TeamMcpToolInheritance;
    if (inheritance.mode === 'inherit_from_assignment') {
      assignment.mcp_tool_inheritance = {
        mode: 'inherit_from_assignment',
        inherit_from_assignment_id: inheritance.inherit_from_assignment_id,
        ...(inheritance.additive_tool_names !== undefined
          ? { additive_tool_names: [...inheritance.additive_tool_names] }
          : {}),
      };
    } else {
      assignment.mcp_tool_inheritance = {
        mode: 'team_permission_matrix',
        ...(inheritance.additive_tool_names !== undefined
          ? { additive_tool_names: [...inheritance.additive_tool_names] }
          : {}),
      };
    }
    assignment.approval_id ??= null;
    assignment.approval_packet_path ??= null;
    assignment.approval_requested_at ??= null;
    assignment.pending_redirect ??= null;
    if (['completed', 'failed', 'timed_out', 'cancelled', 'cascade_stopped'].includes(assignment.status)) {
      assignment.pending_redirect = null;
      assignment.approval_id = null;
      assignment.approval_packet_path = null;
      assignment.approval_requested_at = null;
    }
  }
  const assignmentIds = new Set(state.delegate_assignments.map(item => item.assignment_id));
  state.sessions = state.sessions.filter(session => assignmentIds.has(session.assignment_id));
  for (const assignment of state.delegate_assignments) {
    if (!assignment.session_id) continue;
    if (state.sessions.some(session => session.session_id === assignment.session_id)) continue;
    state.sessions.push(syntheticSession(assignment, runId));
  }
  for (const assignment of state.delegate_assignments) {
    if (!assignment.session_id) continue;
    const session = state.sessions.find(item => item.session_id === assignment.session_id);
    if (!session || session.ended_at !== null) continue;
    if (assignment.status === 'running') continue;
    finalizeAssignmentSession(state, assignment, assignment.updated_at);
  }
  syncPendingApprovals(state, runId);
}

export function openAssignmentSession(
  state: TeamExecutionState,
  runId: string,
  assignment: TeamDelegateAssignment,
  resumeFrom: string | null,
  startedAt: string = utcNowIso(),
): TeamAssignmentSession {
  const parentSessionId = assignment.session_id;
  const hasForkSource = Boolean(assignment.forked_from_assignment_id || assignment.forked_from_session_id);
  const execution = buildDelegatedExecutionIdentity({
    project_run_id: runId,
    assignment_id: assignment.assignment_id,
  });
  const contextKind = resumeFrom !== null
    ? 'resumed'
    : (parentSessionId !== null || hasForkSource)
      ? 'forked'
      : 'fresh';
  const session: TeamAssignmentSession = {
    session_id: randomUUID(),
    parent_session_id: parentSessionId,
    context_kind: contextKind,
    agent_id: assignment.delegate_id,
    assignment_id: assignment.assignment_id,
    runtime_run_id: execution.runtime_run_id,
    runtime_status: 'running',
    task_lifecycle_status: 'running',
    task_status: projectResearchTaskStatusFromLifecycle('running'),
    started_at: startedAt,
    ended_at: null,
    checkpoint_id: assignment.checkpoint_id,
    last_completed_step: assignment.last_completed_step,
    resume_from: resumeFrom,
    forked_from_assignment_id: assignment.forked_from_assignment_id,
    forked_from_session_id: assignment.forked_from_session_id,
  };
  assignment.session_id = session.session_id;
  assignment.updated_at = startedAt;
  state.sessions.push(session);
  state.updated_at = startedAt;
  return session;
}

export function finalizeAssignmentSession(
  state: TeamExecutionState,
  assignment: TeamDelegateAssignment,
  endedAt: string = utcNowIso(),
): TeamAssignmentSession | null {
  if (!assignment.session_id) return null;
  const session = state.sessions.find(item => item.session_id === assignment.session_id);
  if (!session) return null;
  const lifecycle = taskLifecycleFromAssignmentStatus(assignment.status);
  session.runtime_status = assignment.status;
  session.task_lifecycle_status = lifecycle;
  session.task_status = projectResearchTaskStatusFromLifecycle(lifecycle);
  session.ended_at = endedAt;
  session.checkpoint_id = assignment.checkpoint_id;
  session.last_completed_step = assignment.last_completed_step;
  session.resume_from = assignment.resume_from;
  return session;
}

export function syncPendingApprovals(state: TeamExecutionState, runId: string): void {
  state.pending_approvals = state.delegate_assignments
    .map(assignment => pendingApprovalFromAssignment(runId, assignment))
    .filter((entry): entry is TeamPendingApproval => entry !== null);
}
