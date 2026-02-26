/* AUTO-GENERATED — DO NOT EDIT. Source: meta/schemas/ */
/**
 * Structured approval packet for human review of orchestrator gate decisions. Contains purpose, plan, risks, budgets, outputs, rollback, and checklist.
 */
export interface ApprovalPacketV1 {
  /**
   * Schema version, always 1 for this schema.
   */
  schema_version: 1;
  /**
   * Unique approval identifier, e.g. A1-0001.
   */
  approval_id: string;
  /**
   * Gate category (A1–A5).
   */
  gate_id: string;
  /**
   * Run identifier this approval belongs to.
   */
  run_id: string;
  /**
   * Workflow identifier.
   */
  workflow_id?: string;
  /**
   * 1–3 sentence description of what this approval authorizes.
   */
  purpose: string;
  /**
   * Ordered list of plan steps.
   */
  plan: string[];
  /**
   * Known risks and failure modes.
   */
  risks: string[];
  /**
   * Resource budget limits for this approval scope.
   */
  budgets: {
    max_network_calls?: number;
    max_runtime_minutes?: number;
    max_cpu_hours?: number;
    max_gpu_hours?: number;
    max_disk_gb?: number;
  };
  /**
   * Expected output paths/artifacts.
   */
  outputs: string[];
  /**
   * Rollback plan if execution fails or is rejected.
   */
  rollback: string;
  /**
   * Shell commands that will be executed upon approval.
   */
  commands: string[];
  /**
   * Human-readable checklist items for the reviewer.
   */
  checklist: string[];
  /**
   * ISO 8601 UTC Z timestamp of when approval was requested.
   */
  requested_at: string;
  /**
   * Relative path to the context pack file.
   */
  context_pack_path?: string;
  /**
   * Relative path to the run card.
   */
  run_card_path?: string;
  /**
   * SHA-256 of the run card (canonical JSON).
   */
  run_card_sha256?: string;
  /**
   * JSON pointer to the plan in state.json.
   */
  plan_ssot_pointer?: string;
  /**
   * Plan step IDs covered by this approval.
   */
  plan_step_ids?: string[];
  /**
   * Currently active branch ID (if branching is in use).
   */
  active_branch_id?: string;
  /**
   * Trace of gate resolution events leading to this approval.
   */
  gate_resolution_trace?: {
    gate_id?: string;
    triggered_by?: string;
    reason?: string;
    timestamp_utc?: string;
  }[];
  /**
   * Optional extended details in Markdown format.
   */
  details_md?: string;
}
