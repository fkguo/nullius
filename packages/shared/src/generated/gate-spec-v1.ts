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
    /**
     * Machine-checkable launch-precondition policy for production compute runs. When present, launchers must obtain a launch_authorization_v1 result whose verdict is authorized before starting production output; every listed check must pass, and a reviewer recorded unavailable never counts as an approval.
     */
    launch_authorization?: {
      result_schema: "launch_authorization_v1";
      /**
       * @minItems 1
       */
      required_checks: [
        "plan_frozen" | "review_binding" | "fingerprint_match",
        ...("plan_frozen" | "review_binding" | "fingerprint_match")[],
      ];
    };
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
