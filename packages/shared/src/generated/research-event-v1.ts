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
