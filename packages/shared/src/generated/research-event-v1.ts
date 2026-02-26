/* AUTO-GENERATED — DO NOT EDIT. Source: meta/schemas/ */
/**
 * An audit record of a research process event. Events form the input stream for the REP Signal Engine (EVO-18).
 */
export interface ResearchEventV1 {
  schema_version: 1;
  /**
   * Unique event identifier (UUID v4).
   */
  event_id: string;
  /**
   * Type of research event. Determines which payload schema applies (discriminated union).
   */
  event_type:
    | "strategy_proposed"
    | "strategy_selected"
    | "strategy_rejected"
    | "computation_started"
    | "computation_completed"
    | "computation_failed"
    | "verification_started"
    | "verification_passed"
    | "verification_failed"
    | "outcome_published"
    | "outcome_superseded"
    | "outcome_revoked"
    | "integrity_check_started"
    | "integrity_check_completed"
    | "signal_detected"
    | "stagnation_detected"
    | "diagnostic_emitted";
  /**
   * ISO 8601 UTC Z timestamp.
   */
  timestamp: string;
  /**
   * Run in which this event occurred.
   */
  run_id: string;
  /**
   * Trace ID for cross-layer correlation (UUID v4).
   */
  trace_id?: string;
  /**
   * Monotonically increasing sequence number within a run.
   */
  sequence_number?: number;
  /**
   * Event-type-specific payload data. Schema is enforced by the event_type discriminator (see allOf).
   */
  payload: {
    [k: string]: unknown;
  };
}
/**
 * This interface was referenced by `ResearchEventV1`'s JSON-Schema
 * via the `definition` "StrategyProposedPayload".
 */
export interface StrategyProposedPayload {
  strategy_id: string;
  strategy_name: string;
  preset: "explore" | "deepen" | "verify" | "consolidate";
  /**
   * Signal IDs that triggered this proposal.
   */
  triggering_signals?: string[];
  score?: number;
  [k: string]: unknown;
}
/**
 * This interface was referenced by `ResearchEventV1`'s JSON-Schema
 * via the `definition` "StrategySelectedPayload".
 */
export interface StrategySelectedPayload {
  strategy_id: string;
  reason: string;
  competing_strategies?: {
    strategy_id?: string;
    score?: number;
    [k: string]: unknown;
  }[];
  [k: string]: unknown;
}
/**
 * This interface was referenced by `ResearchEventV1`'s JSON-Schema
 * via the `definition` "StrategyRejectedPayload".
 */
export interface StrategyRejectedPayload {
  strategy_id: string;
  reason: string;
  [k: string]: unknown;
}
/**
 * This interface was referenced by `ResearchEventV1`'s JSON-Schema
 * via the `definition` "ComputationStartedPayload".
 */
export interface ComputationStartedPayload {
  computation_id: string;
  strategy_ref: string;
  method: string;
  tools?: string[];
  parameters?: {
    [k: string]: unknown;
  };
  [k: string]: unknown;
}
/**
 * This interface was referenced by `ResearchEventV1`'s JSON-Schema
 * via the `definition` "ComputationCompletedPayload".
 */
export interface ComputationCompletedPayload {
  computation_id: string;
  /**
   * ArtifactRef V1 of the computation result.
   */
  artifact_ref: {
    [k: string]: unknown;
  };
  /**
   * Summary of computed quantities.
   */
  metrics_summary?: {
    [k: string]: unknown;
  };
  duration_ms?: number;
  [k: string]: unknown;
}
/**
 * This interface was referenced by `ResearchEventV1`'s JSON-Schema
 * via the `definition` "ComputationFailedPayload".
 */
export interface ComputationFailedPayload {
  computation_id: string;
  error: {
    code: string;
    message: string;
    retryable?: boolean;
    [k: string]: unknown;
  };
  /**
   * Any partial results before failure.
   */
  partial_results?: {
    [k: string]: unknown;
  };
  [k: string]: unknown;
}
/**
 * This interface was referenced by `ResearchEventV1`'s JSON-Schema
 * via the `definition` "VerificationStartedPayload".
 */
export interface VerificationStartedPayload {
  verification_id: string;
  original_computation_id: string;
  /**
   * Verification method type. Domain Pack defines available types (e.g., 'different_package', 'different_approach', 'different_precision', 'different_gauge', 'formal_proof_check', 'alternative_proof').
   */
  method: string;
  [k: string]: unknown;
}
/**
 * This interface was referenced by `ResearchEventV1`'s JSON-Schema
 * via the `definition` "VerificationPassedPayload".
 */
export interface VerificationPassedPayload {
  verification_id: string;
  deviation_report_ref: string;
  max_relative_deviation?: number;
  [k: string]: unknown;
}
/**
 * This interface was referenced by `ResearchEventV1`'s JSON-Schema
 * via the `definition` "VerificationFailedPayload".
 */
export interface VerificationFailedPayload {
  verification_id: string;
  deviation_report_ref: string;
  reason: string;
  max_relative_deviation?: number;
  [k: string]: unknown;
}
/**
 * This interface was referenced by `ResearchEventV1`'s JSON-Schema
 * via the `definition` "OutcomePublishedPayload".
 */
export interface OutcomePublishedPayload {
  outcome_id: string;
  strategy_ref: string;
  rdi_rank_score?: number;
  [k: string]: unknown;
}
/**
 * This interface was referenced by `ResearchEventV1`'s JSON-Schema
 * via the `definition` "OutcomeSupersededPayload".
 */
export interface OutcomeSupersededPayload {
  outcome_id: string;
  superseded_by: string;
  reason?: string;
  [k: string]: unknown;
}
/**
 * This interface was referenced by `ResearchEventV1`'s JSON-Schema
 * via the `definition` "OutcomeRevokedPayload".
 */
export interface OutcomeRevokedPayload {
  outcome_id: string;
  reason: string;
  [k: string]: unknown;
}
/**
 * This interface was referenced by `ResearchEventV1`'s JSON-Schema
 * via the `definition` "IntegrityCheckStartedPayload".
 */
export interface IntegrityCheckStartedPayload {
  report_id: string;
  target_ref: {
    [k: string]: unknown;
  };
  domain: string;
  /**
   * Check IDs to be executed.
   */
  checks?: string[];
  [k: string]: unknown;
}
/**
 * This interface was referenced by `ResearchEventV1`'s JSON-Schema
 * via the `definition` "IntegrityCheckCompletedPayload".
 */
export interface IntegrityCheckCompletedPayload {
  report_id: string;
  overall_status: "pass" | "fail" | "advisory_only";
  blocking_failures?: string[];
  check_count?: number;
  pass_count?: number;
  fail_count?: number;
  [k: string]: unknown;
}
/**
 * This interface was referenced by `ResearchEventV1`'s JSON-Schema
 * via the `definition` "SignalDetectedPayload".
 */
export interface SignalDetectedPayload {
  /**
   * Reference to the ResearchSignal (UUID v4, matches ResearchSignal.signal_id).
   */
  signal_id: string;
  signal_type:
    | "gap_detected"
    | "calculation_divergence"
    | "known_result_match"
    | "integrity_violation"
    | "method_plateau"
    | "parameter_sensitivity"
    | "cross_check_opportunity"
    | "stagnation";
  confidence: number;
  fingerprint?: string;
  source_event_ids?: string[];
  [k: string]: unknown;
}
/**
 * This interface was referenced by `ResearchEventV1`'s JSON-Schema
 * via the `definition` "StagnationDetectedPayload".
 */
export interface StagnationDetectedPayload {
  consecutive_empty_cycles: number;
  threshold: number;
  current_strategy?: string;
  recommended_action?:
    | "switch_strategy"
    | "abandon_direction"
    | "request_guidance";
  [k: string]: unknown;
}
/**
 * This interface was referenced by `ResearchEventV1`'s JSON-Schema
 * via the `definition` "DiagnosticEmittedPayload".
 */
export interface DiagnosticEmittedPayload {
  /**
   * Type of diagnostic event (e.g., 'taxonomy_miss', 'taxonomy_expansion_proposed', 'taxonomy_entry_added', 'taxonomy_entry_rejected', 'fallback_applied', 'config_warning'). Not a research signal — used for observability and debugging.
   */
  diagnostic_type: string;
  /**
   * Human-readable diagnostic message.
   */
  message: string;
  /**
   * Diagnostic-type-specific context data.
   */
  context?: {
    [k: string]: unknown;
  };
  /**
   * Log-level severity of the diagnostic (not to be confused with IntegrityViolationPayload check severity which uses 'blocking'|'advisory').
   */
  severity?: "info" | "warning" | "error";
  [k: string]: unknown;
}
