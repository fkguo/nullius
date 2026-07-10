// @nullius/orchestrator — lifecycle state and approval policy types

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

/** Where project truth lives and which closeout surface applies.
 *  'engine': the nullius run/approve lifecycle drives the project.
 *  'file': work is executed by hand or by external runners; durable truth
 *  lives in research_plan.md / research_contract.md and dated run
 *  directories, and run_status legitimately stays 'idle'.
 *  Absent/null: never declared (legacy projects); status may hint when the
 *  observable evidence looks file-mode. */
export type ExecutionMode = 'engine' | 'file';

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

export interface WorkflowOutputView {
  step_id: string;
  tool: string;
  runtime_status: 'completed' | 'partial' | 'skipped' | 'failed';
  artifact_uri: string | null;
  additional_artifact_uris: string[];
  summary_text: string;
  reason_code: string | null;
  recoverable: boolean;
  payload: unknown | null;
  payload_truncated: boolean;
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
  workflow_outputs: Record<string, WorkflowOutputView>;
  notes: string;
  /** Declared via `nullius init --mode=<engine|file>`; never inferred. */
  execution_mode?: ExecutionMode | null;
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
