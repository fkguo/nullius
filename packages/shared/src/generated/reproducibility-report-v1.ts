/* AUTO-GENERATED — DO NOT EDIT. Source: meta/schemas/ */
/**
 * Report comparing an original computation result with an independent re-computation. Used by EVO-07 reproducibility verification pipeline. Content-addressed via SHA-256 of RFC 8785 (JCS) canonical JSON. Scope: numerical/computational verification only. For formal verification methods (formal_proof_check, mechanized_verification), outcomes use reproducibility_status='not_applicable' in the ResearchOutcome schema; proof artifacts are tracked by the Domain Pack, not this report.
 */
export interface ReproducibilityReportV1DeviationReport {
  schema_version: 1;
  /**
   * Content-addressed identifier: SHA-256 hex digest of RFC 8785 (JCS) canonical JSON of this object excluding report_id itself.
   */
  report_id: string;
  /**
   * ArtifactRef V1 of the original computation result.
   */
  original_ref: {
    uri: string;
    kind?: string;
    sha256: string;
    size_bytes?: number;
    produced_by?: string;
    created_at?: string;
    [k: string]: unknown;
  };
  /**
   * ArtifactRef V1 of the re-computation result.
   */
  rerun_ref: {
    uri: string;
    kind?: string;
    sha256: string;
    size_bytes?: number;
    produced_by?: string;
    created_at?: string;
    [k: string]: unknown;
  };
  /**
   * Description of the independent method used for re-computation. Only 'type' is required; Domain Packs define additional fields (e.g., HEP: package, approach, precision, gauge).
   */
  rerun_method: {
    /**
     * Type of independent verification method. Domain Pack defines available types. Computational examples: 'different_tool', 'different_approach', 'different_precision'. Note: formal methods (formal_proof_check, mechanized_verification) do NOT produce ReproducibilityReports; outcomes from formal methods use reproducibility_status='not_applicable' in the ResearchOutcome schema instead.
     */
    type: string;
    [k: string]: unknown;
  };
  /**
   * Per-quantity comparison results. Must contain at least one entry unless overall_agreement is 'unknown' (re-computation could not complete).
   */
  quantities: QuantityComparison[];
  /**
   * 'agree' if all quantities within tolerance. 'disagree' if any quantity outside tolerance with deviation_source 'potential_error'. 'partial' if some agree and some disagree. 'unknown' if re-computation could not complete or results are not comparable.
   */
  overall_agreement: "agree" | "disagree" | "partial" | "unknown";
  /**
   * Run in which this verification was performed.
   */
  run_id?: string;
  trace_id?: string;
  /**
   * ISO 8601 UTC Z timestamp.
   */
  created_at: string;
  /**
   * Total time for re-computation + comparison in milliseconds.
   */
  duration_ms?: number;
  /**
   * Additional notes about the verification.
   */
  notes?: string;
}
/**
 * This interface was referenced by `ReproducibilityReportV1DeviationReport`'s JSON-Schema
 * via the `definition` "QuantityComparison".
 */
export interface QuantityComparison {
  /**
   * Name of the compared quantity (e.g., 'sigma_total', 'Gamma_H_bb').
   */
  quantity_name: string;
  original_value: NumericValue;
  rerun_value: NumericValue;
  /**
   * Absolute difference |original - rerun|.
   */
  absolute_deviation: number;
  /**
   * Relative difference |original - rerun| / |original|. Zero if original is zero.
   */
  relative_deviation: number;
  /**
   * Whether the deviation is within the specified tolerance.
   */
  within_tolerance: boolean;
  tolerance_used: ToleranceSpec;
  /**
   * Classified source of the deviation. 'numerical_precision' for expected machine-level differences. 'method_difference' for expected differences from different approaches. 'potential_error' for unexplained large deviations.
   */
  deviation_source?:
    | "numerical_precision"
    | "method_difference"
    | "potential_error"
    | "unknown";
  /**
   * Explanation of deviation or additional context.
   */
  notes?: string;
}
/**
 * This interface was referenced by `ReproducibilityReportV1DeviationReport`'s JSON-Schema
 * via the `definition` "NumericValue".
 */
export interface NumericValue {
  /**
   * Central/best value.
   */
  central: number;
  /**
   * Statistical or numerical uncertainty.
   */
  uncertainty?: number;
  /**
   * Unit of measurement. Omit for dimensionless quantities. Interpretation of units is domain-pack-defined.
   */
  unit?: string;
}
/**
 * This interface was referenced by `ReproducibilityReportV1DeviationReport`'s JSON-Schema
 * via the `definition` "ToleranceSpec".
 */
export interface ToleranceSpec {
  /**
   * Maximum allowed absolute deviation.
   */
  absolute?: number;
  /**
   * Maximum allowed relative deviation.
   */
  relative?: number;
  /**
   * 'stricter_of' means both absolute and relative must be satisfied. 'either' means satisfying one is enough.
   */
  method?: "stricter_of" | "either";
}
