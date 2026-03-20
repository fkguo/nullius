/* AUTO-GENERATED — DO NOT EDIT. Source: meta/schemas/ */
/**
 * Approval packet with approval-specific context enrichment (UX-07). Extends V1 by adding optional context_summary, key_results, integrity_flags, and recommendation fields. All new fields are optional for backward compatibility.
 */
export interface ApprovalPacketV2 {
  /**
   * Schema version. 1 = base fields only (v1-compatible). 2 = includes UX-07 enrichment fields (context_summary, key_results, integrity_flags, recommendation).
   */
  schema_version: 1 | 2;
  /**
   * Unique approval identifier, e.g. A1-0001.
   */
  approval_id: string;
  /**
   * Approval category identifier (A0–A5) for the approval checkpoint being requested.
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
   * Approval-resolution provenance for this request, showing how A0–A5 approval requirements were derived from policy, run-card, workflow defaults, or CLI overrides.
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
  /**
   * (UX-07) Gate-specific one-line context summary assembled by the per-gate context assembler (A0–A5).
   */
  context_summary?: string;
  /**
   * (UX-07) Key numerical or categorical results assembled by the gate context assembler.
   */
  key_results?: {
    /**
     * Short label for the result.
     */
    label: string;
    /**
     * Value as string (may include formatting).
     */
    value: string;
    /**
     * Physical unit or dimension, if applicable.
     */
    unit?: string;
    /**
     * Source citation or artifact reference.
     */
    source?: string;
  }[];
  /**
   * (UX-07) Anomaly or integrity warnings raised by the gate context assembler.
   */
  integrity_flags?: string[];
  /**
   * (UX-07) One-line reviewer recommendation, e.g. 'APPROVE', 'REVIEW CAREFULLY', 'REQUEST REVISION'.
   */
  recommendation?: string;
}
