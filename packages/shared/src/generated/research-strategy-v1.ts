/* AUTO-GENERATED — DO NOT EDIT. Source: meta/schemas/ */
/**
 * A reusable research strategy template defining methodology, constraints, and validation criteria. Content-addressed via SHA-256 of RFC 8785 (JCS) canonical JSON.
 */
export interface ResearchStrategyV1 {
  /**
   * Schema version, must be 1 for this version.
   */
  schema_version: 1;
  /**
   * Content-addressed identifier: SHA-256 hex digest of RFC 8785 (JCS) canonical JSON of this object excluding strategy_id itself.
   */
  strategy_id: string;
  /**
   * Human-readable name for this strategy.
   */
  name: string;
  /**
   * Detailed description of the strategy.
   */
  description: string;
  /**
   * What this strategy aims to achieve.
   */
  objective: string;
  method: {
    /**
     * Research method or technique. Examples: 'one-loop perturbative calculation', 'lattice Monte Carlo simulation', 'formal proof via cobordism', 'dispersive analysis'.
     */
    approach: string;
    /**
     * Required computation or analysis tools (e.g., ['FeynCalc', 'LoopTools'], ['Lean4'], ['Mathematica']).
     */
    tools: string[];
    /**
     * Theoretical framework or model (e.g., 'Standard Model', 'N=4 SYM', 'Ising model').
     */
    model?: string;
    [k: string]: unknown;
  };
  /**
   * Applicability constraints for this strategy.
   */
  constraints?: {
    /**
     * Valid parameter ranges for this strategy.
     */
    parameter_ranges?: {
      [k: string]: {
        min?: number;
        max?: number;
        unit?: string;
        [k: string]: unknown;
      };
    };
    /**
     * Approximations used and their validity conditions.
     */
    approximations?: {
      name: string;
      validity_condition: string;
      estimated_error?: string;
      [k: string]: unknown;
    }[];
    /**
     * Domain-specific assumptions. Examples: HEP: 'CP conservation', 'massless light quarks'; formal: 'excluded middle', 'axiom of choice'.
     */
    assumptions?: string[];
    [k: string]: unknown;
  };
  /**
   * What form the results should take.
   */
  expected_outcome_form?: {
    /**
     * Expected output quantities.
     */
    quantities?: {
      name: string;
      /**
       * V1 quantity types cover numerical/computational domains. V2 will add 'boolean', 'symbolic', 'category' for formal methods and classification workflows (see DESIGN_DEBT.md item 6).
       */
      type?: "scalar" | "vector" | "matrix" | "function" | "distribution";
      unit?: string;
      [k: string]: unknown;
    }[];
    /**
     * Expected result format. Recommended values: 'analytic_expression', 'numerical_table', 'parametric_fit', 'formal_proof', 'classification_result', 'mixed'. Domain Packs may define additional conventions.
     */
    format?: string;
    [k: string]: unknown;
  };
  /**
   * Research domain (e.g., 'hep-th', 'hep-ph', 'cond-mat').
   */
  domain: string;
  /**
   * Conditions under which this strategy is applicable.
   */
  applicable_when?: string[];
  /**
   * Criteria for verifying outcomes produced by this strategy.
   *
   * @minItems 1
   */
  validation_criteria: [
    {
      /**
       * Criterion name (e.g., 'consistency_check', 'known_limit_check'). Domain Pack defines available criteria.
       */
      name: string;
      /**
       * How to verify (e.g., 'compare results from two independent methods'). Domain Pack provides concrete verification procedures.
       */
      method: string;
      /**
       * Acceptable deviation (relative).
       */
      tolerance?: number;
      /**
       * Whether this criterion is required for outcome verification.
       */
      required?: boolean;
      [k: string]: unknown;
    },
    ...{
      /**
       * Criterion name (e.g., 'consistency_check', 'known_limit_check'). Domain Pack defines available criteria.
       */
      name: string;
      /**
       * How to verify (e.g., 'compare results from two independent methods'). Domain Pack provides concrete verification procedures.
       */
      method: string;
      /**
       * Acceptable deviation (relative).
       */
      tolerance?: number;
      /**
       * Whether this criterion is required for outcome verification.
       */
      required?: boolean;
      [k: string]: unknown;
    }[],
  ];
  /**
   * Strategy preset category for signal engine.
   */
  preset?: "explore" | "deepen" | "verify" | "consolidate";
  /**
   * Free-form tags for categorization.
   */
  tags?: string[];
}
