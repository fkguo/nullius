/* AUTO-GENERATED — DO NOT EDIT. Source: meta/schemas/ */
/**
 * Structured machine-readable output contract for research-team convergence gates.
 */
export interface ConvergenceGateResultV1 {
  status: "converged" | "not_converged" | "parse_error" | "early_stop";
  exit_code: 0 | 1 | 2 | 3;
  reasons: string[];
  report_status: {
    /**
     * This interface was referenced by `undefined`'s JSON-Schema definition
     * via the `patternProperty` "^[a-z][a-z0-9_]*$".
     */
    [k: string]: {
      verdict: "ready" | "needs_revision" | "unknown";
      blocking_count: number | null;
      parse_ok: boolean;
      derivation?: "pass" | "fail" | "unknown";
      computation?: "pass" | "fail" | "unknown";
      sweep_semantics?: "pass" | "fail" | "unknown";
      challenged_steps?: number;
      confirmed_steps?: number;
      unverifiable_steps?: number;
      independent_derivation?: boolean;
      nontriviality_validated?: boolean;
      source_path?: string;
      errors?: string[];
      [k: string]: unknown;
    };
  };
  meta: {
    gate_id: "team_convergence" | "draft_convergence";
    generated_at: string;
    parser_version: string;
    schema_id: "convergence_gate_result_v1";
    schema_version: 1;
    workflow_mode?: "peer" | "leader" | "asymmetric";
    require_sweep?: boolean;
    tag?: string;
    [k: string]: unknown;
  };
}
