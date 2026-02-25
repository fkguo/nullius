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
