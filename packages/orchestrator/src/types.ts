// @autoresearch/orchestrator — Shared types (NEW-05a Stage 1)
// Compatible with Python orchestrator_state.py schema_version: 1
// Python is SSOT; TS types must mirror Python's state.json shape exactly.

export type RunStatus =
  | 'idle'
  | 'running'
  | 'paused'
  | 'blocked'
  | 'rejected'
  | 'needs_recovery'
  | 'awaiting_approval'
  | 'completed'
  | 'failed';

export interface PendingApproval {
  approval_id: string;
  category: string;
  plan_step_ids: string[];
  requested_at: string;
  timeout_at: string | null;
  on_timeout: string; // 'block' | 'reject' | 'escalate' — Python writes arbitrary string
  packet_path: string;
}

export interface ApprovalHistoryEntry {
  ts: string;
  approval_id: string;
  category: string | null;
  decision: 'approved' | 'rejected' | 'timeout_rejected';
  note: string;
}

export interface CheckpointInfo {
  last_checkpoint_at: string | null;
  checkpoint_interval_seconds: number;
}

export interface CurrentStep {
  step_id: string;
  title?: string;
  started_at: string;
}

export interface RunState {
  schema_version: 1;
  run_id: string | null;
  workflow_id: string | null;
  run_status: RunStatus;
  current_step: CurrentStep | null;
  plan: Record<string, unknown> | null;
  plan_md_path: string | null;
  checkpoints: CheckpointInfo;
  /** Root-run approval slot only. Delegated approvals live in team-execution-state.json. */
  pending_approval: PendingApproval | null;
  approval_seq: Record<string, number>;
  gate_satisfied: Record<string, string | boolean>;
  approval_history: ApprovalHistoryEntry[];
  artifacts: Record<string, string>;
  notes: string;
  /** Saved before pause so resume can restore the original status.
   *  Python uses pop/setdefault pattern; TS uses optional field. */
  paused_from_status?: RunStatus;
}

export interface LedgerEvent {
  ts: string;
  event_type: string;
  run_id: string | null;
  workflow_id: string | null;
  step_id: string | null;
  details: Record<string, unknown>;
}

/**
 * Mirrors the full Python approval_policy.schema.json structure.
 * Python reads budgets.max_approvals, timeouts.<category>.timeout_seconds, etc.
 */
export interface ApprovalPolicyBudgets {
  max_network_calls?: number;
  max_runtime_minutes?: number;
  max_approvals?: number;
}

export interface ApprovalPolicyTimeoutEntry {
  timeout_seconds: number;
  on_timeout: string;
}

export interface ApprovalPolicy {
  schema_version?: number;
  mode?: string;
  require_approval_for?: Record<string, boolean>;
  budgets?: ApprovalPolicyBudgets;
  timeouts?: Record<string, ApprovalPolicyTimeoutEntry>;
  notes?: string;
}
