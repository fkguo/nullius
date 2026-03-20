/* AUTO-GENERATED — DO NOT EDIT. Source: meta/schemas/ */
/**
 * Generic gate authority contract shared across approval, quality, and convergence checkpoints.
 */
export interface GateSpecV1 {
  /**
   * Stable gate identifier, e.g. A1 or team_convergence.
   */
  gate_id: string;
  /**
   * Generic gate taxonomy. Approval checkpoints are one gate type, not the whole abstraction.
   */
  gate_type: "approval" | "quality" | "convergence";
  /**
   * Human-readable authority boundary or workflow scope for the gate.
   */
  scope: string;
  /**
   * Gate-specific policy metadata or parameters.
   */
  policy: {
    [k: string]: unknown;
  };
  /**
   * Enforcement posture when the gate cannot be evaluated.
   */
  fail_behavior: "fail-open" | "fail-closed";
  /**
   * Whether the gate must emit auditable provenance when enforced.
   */
  audit_required: boolean;
}
