/* AUTO-GENERATED — DO NOT EDIT. Source: meta/schemas/ */
/**
 * A research signal detected by the REP Signal Engine (EVO-18). Signals drive strategy selection for research evolution.
 */
export interface ResearchSignalV1 {
  schema_version: 1;
  /**
   * Unique signal identifier (UUID v4).
   */
  signal_id: string;
  /**
   * Type of research signal detected. Determines which payload schema applies (discriminated union).
   */
  signal_type:
    | "gap_detected"
    | "calculation_divergence"
    | "known_result_match"
    | "integrity_violation"
    | "method_plateau"
    | "parameter_sensitivity"
    | "cross_check_opportunity"
    | "stagnation";
  /**
   * ResearchEvent IDs that triggered this signal.
   *
   * @minItems 1
   */
  source_event_ids: [string, ...string[]];
  /**
   * Dedup fingerprint: hash of signal_type + distinguishing features. Same fingerprint within dedup_window means duplicate.
   */
  fingerprint: string;
  /**
   * Confidence in the signal (0-1).
   */
  confidence: number;
  /**
   * Signal priority for strategy selection.
   */
  priority: "critical" | "high" | "medium" | "low";
  /**
   * Signal-type-specific payload data. Schema is enforced by the signal_type discriminator (see allOf).
   */
  payload: {
    [k: string]: unknown;
  };
  /**
   * ISO 8601 UTC Z timestamp of detection.
   */
  detected_at: string;
  /**
   * Optional expiry timestamp. Signal is ignored after this time.
   */
  expires_at?: string;
  /**
   * Run in which this signal was detected.
   */
  run_id?: string;
  /**
   * Whether this signal has been suppressed (deduped or manually dismissed).
   */
  suppressed?: boolean;
}
/**
 * This interface was referenced by `ResearchSignalV1`'s JSON-Schema
 * via the `definition` "GapDetectedPayload".
 */
export interface GapDetectedPayload {
  /**
   * Description of the knowledge gap.
   */
  gap_description: string;
  /**
   * Area of the domain where gap exists.
   */
  domain_area: string;
  /**
   * Literature records (from LiteratureService) of related work that highlights the gap.
   */
  related_literature?: {
    /**
     * Literature record identifier.
     */
    record_id: string;
    /**
     * Which LiteratureService provided this record (matches LiteratureService.serviceId).
     */
    source: string;
    [k: string]: unknown;
  }[];
  /**
   * Estimated impact of filling this gap.
   */
  estimated_impact?: "high" | "medium" | "low";
  [k: string]: unknown;
}
/**
 * This interface was referenced by `ResearchSignalV1`'s JSON-Schema
 * via the `definition` "CalculationDivergencePayload".
 */
export interface CalculationDivergencePayload {
  /**
   * ID of first outcome.
   */
  outcome_a_ref: string;
  /**
   * ID of second outcome.
   */
  outcome_b_ref: string;
  divergent_quantities: {
    name: string;
    value_a: number;
    value_b: number;
    relative_deviation: number;
    [k: string]: unknown;
  }[];
  /**
   * Reference to the DeviationReport if from EVO-07.
   */
  deviation_report_ref?: string;
  [k: string]: unknown;
}
/**
 * This interface was referenced by `ResearchSignalV1`'s JSON-Schema
 * via the `definition` "KnownResultMatchPayload".
 */
export interface KnownResultMatchPayload {
  outcome_ref: string;
  matching_literature: {
    /**
     * Literature record identifier (e.g., INSPIRE recid, CrossRef DOI, OpenAlex work ID).
     */
    record_id: string;
    /**
     * Which LiteratureService provided this record (matches LiteratureService.serviceId).
     */
    source: string;
    title?: string;
    similarity_score: number;
    matched_quantities?: string[];
    [k: string]: unknown;
  }[];
  [k: string]: unknown;
}
/**
 * This interface was referenced by `ResearchSignalV1`'s JSON-Schema
 * via the `definition` "IntegrityViolationPayload".
 */
export interface IntegrityViolationPayload {
  integrity_report_ref: string;
  failed_checks: {
    check_id: string;
    severity: "blocking" | "advisory";
    message?: string;
    [k: string]: unknown;
  }[];
  [k: string]: unknown;
}
/**
 * This interface was referenced by `ResearchSignalV1`'s JSON-Schema
 * via the `definition` "MethodPlateauPayload".
 */
export interface MethodPlateauPayload {
  current_method: string;
  cycles_without_improvement: number;
  best_achieved_metric?: string;
  suggested_alternatives?: string[];
  [k: string]: unknown;
}
/**
 * This interface was referenced by `ResearchSignalV1`'s JSON-Schema
 * via the `definition` "ParameterSensitivityPayload".
 */
export interface ParameterSensitivityPayload {
  parameter_name: string;
  /**
   * Relative change in result per relative change in parameter (dimensionless).
   */
  sensitivity_measure: number;
  parameter_range_tested?: {
    min?: number;
    max?: number;
    [k: string]: unknown;
  };
  affected_quantities?: string[];
  [k: string]: unknown;
}
/**
 * This interface was referenced by `ResearchSignalV1`'s JSON-Schema
 * via the `definition` "CrossCheckOpportunityPayload".
 */
export interface CrossCheckOpportunityPayload {
  new_outcome_ref: string;
  existing_outcome_refs: string[];
  /**
   * Type of cross-check enabled by this new result. Domain Pack defines available types (e.g., 'limit_agreement', 'ward_identity', 'gauge_invariance', 'sum_rule' for HEP).
   */
  cross_check_type?: string;
  [k: string]: unknown;
}
/**
 * This interface was referenced by `ResearchSignalV1`'s JSON-Schema
 * via the `definition` "StagnationPayload".
 */
export interface StagnationPayload {
  consecutive_empty_cycles: number;
  threshold: number;
  current_strategy?: string;
  last_productive_cycle?: string;
  recommended_action?:
    | "switch_strategy"
    | "abandon_direction"
    | "request_guidance";
  [k: string]: unknown;
}
