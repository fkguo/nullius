import type { DelegatedRuntimeProjectionV1 } from './research-loop/delegated-runtime-projection.js';
import {
  projectResearchTaskStatusFromLifecycle,
  type ResearchTaskLifecycleProjection,
  type ResearchTaskStatus,
} from './research-loop/task-types.js';
import type { TeamAssignmentStatus } from './team-execution-types.js';

export type RuntimeDiagnosticsStatusV1 = 'ok' | 'degraded' | 'needs_recovery' | 'awaiting_approval' | 'failed';

export type RuntimeDiagnosticsCauseV1 =
  | 'none'
  | 'diminishing_returns'
  | 'context_overflow'
  | 'truncation'
  | 'approval_required'
  | 'runtime_error'
  | 'max_turns'
  | 'unknown_terminal';

export type RuntimeDiagnosticsActionV1 =
  | 'none'
  | 'inspect_runtime_evidence'
  | 'reframe_or_replan_before_resume'
  | 'approve_or_reject_and_resume'
  | 'compact_or_reduce_context';

export interface RuntimeDiagnosticsSummaryV1 {
  status: RuntimeDiagnosticsStatusV1;
  primary_cause: RuntimeDiagnosticsCauseV1;
  recommended_action: RuntimeDiagnosticsActionV1;
}

export interface TeamTaskProjectionStatus {
  task_lifecycle_status: ResearchTaskLifecycleProjection;
  task_status: ResearchTaskStatus;
}

export function summarizeRuntimeProjectionForOperator(
  runtimeProjection: DelegatedRuntimeProjectionV1,
): RuntimeDiagnosticsSummaryV1 {
  if (runtimeProjection.terminal_outcome?.type === 'error') {
    return { status: 'failed', primary_cause: 'runtime_error', recommended_action: 'inspect_runtime_evidence' };
  }
  if (runtimeProjection.approval_requested) {
    return { status: 'awaiting_approval', primary_cause: 'approval_required', recommended_action: 'approve_or_reject_and_resume' };
  }
  if (runtimeProjection.runtime_marker_kinds.includes('diminishing_returns_stop')) {
    return { status: 'needs_recovery', primary_cause: 'diminishing_returns', recommended_action: 'reframe_or_replan_before_resume' };
  }
  if (runtimeProjection.runtime_marker_kinds.includes('context_overflow_retry')) {
    return { status: 'degraded', primary_cause: 'context_overflow', recommended_action: 'compact_or_reduce_context' };
  }
  if (runtimeProjection.runtime_marker_kinds.includes('truncation_retry')) {
    return { status: 'degraded', primary_cause: 'truncation', recommended_action: 'compact_or_reduce_context' };
  }
  if (runtimeProjection.terminal_outcome?.type === 'done' && runtimeProjection.terminal_outcome.stop_reason === 'max_turns') {
    return { status: 'degraded', primary_cause: 'max_turns', recommended_action: 'reframe_or_replan_before_resume' };
  }
  if (runtimeProjection.terminal_outcome?.type === 'done') {
    return { status: 'ok', primary_cause: 'none', recommended_action: 'none' };
  }
  return { status: 'degraded', primary_cause: 'unknown_terminal', recommended_action: 'inspect_runtime_evidence' };
}

export function taskLifecycleFromOperatorAssignmentStatus(
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

export function taskProjectionFromAssignmentStatus(
  status: TeamAssignmentStatus,
): TeamTaskProjectionStatus {
  const task_lifecycle_status = taskLifecycleFromOperatorAssignmentStatus(status);
  return {
    task_lifecycle_status,
    task_status: projectResearchTaskStatusFromLifecycle(task_lifecycle_status),
  };
}

export function assignmentNeedsApprovalAttention(
  status: TeamAssignmentStatus,
  pausedFromStatus: TeamAssignmentStatus | null,
): boolean {
  return status === 'awaiting_approval'
    || (status === 'paused' && pausedFromStatus === 'awaiting_approval');
}

export function deriveLedgerStatusFromOperatorEvent(
  eventType: string,
  details: Record<string, unknown>,
  previous: string,
): { status: string; unmappedEvent: string | null } {
  if (eventType === 'initialized') return { status: 'idle', unmappedEvent: null };
  if (eventType === 'run_started' || eventType === 'resumed') {
    return { status: 'running', unmappedEvent: null };
  }
  if (eventType === 'approval_approved') {
    return {
      status: details.category === 'A5' ? 'completed' : 'running',
      unmappedEvent: null,
    };
  }
  if (eventType === 'approval_requested') return { status: 'awaiting_approval', unmappedEvent: null };
  if (eventType === 'approval_rejected' || eventType === 'paused') return { status: 'paused', unmappedEvent: null };
  if (eventType === 'approval_budget_exhausted') return { status: 'blocked', unmappedEvent: null };
  if (eventType === 'workflow_step_started') return { status: 'running', unmappedEvent: null };
  if (eventType === 'workflow_step_completed' || eventType === 'workflow_step_skipped') {
    return {
      status: details.next_step_id ? 'running' : 'completed',
      unmappedEvent: null,
    };
  }
  if (eventType === 'workflow_step_failed' || eventType === 'workflow_step_selection_failed') {
    return { status: 'failed', unmappedEvent: null };
  }
  if (eventType === 'workflow_plan_completed') return { status: 'completed', unmappedEvent: null };
  if (eventType === 'approval_timeout') {
    const policyAction = typeof details.policy_action === 'string' ? details.policy_action : '';
    if (policyAction === 'reject') return { status: 'rejected', unmappedEvent: null };
    if (policyAction === 'escalate') return { status: 'needs_recovery', unmappedEvent: null };
    return { status: 'blocked', unmappedEvent: null };
  }
  if (eventType.startsWith('status_')) {
    // Keep operator-authored status_* events extensible instead of freezing the
    // ledger to the current built-in filter enum.
    const status = eventType.slice('status_'.length);
    return status
      ? { status, unmappedEvent: null }
      : { status: previous, unmappedEvent: 'status_(empty)' };
  }
  return { status: previous, unmappedEvent: eventType || '(missing event_type)' };
}
