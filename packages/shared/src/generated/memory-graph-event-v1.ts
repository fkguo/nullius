/* AUTO-GENERATED — DO NOT EDIT. Source: meta/schemas/ */
/**
 * Event type enumeration (ported from Evolver)
 */
export type EventType =
  | "signal"
  | "hypothesis"
  | "attempt"
  | "outcome"
  | "confidence_edge"
  | "confidence_gene_outcome"
  | "external_candidate";

/**
 * Append-only event in the Cross-Cycle Memory Graph. Ported from Evolver memoryGraph.js (MIT, AutoGame Limited).
 */
export interface MemoryGraphEventV1 {
  /**
   * Auto-incremented event ID
   */
  id?: number;
  event_type: EventType;
  /**
   * Run ID (null for cross-run context events)
   */
  run_id?: string | null;
  /**
   * Trace ID from H-02 observability
   */
  trace_id?: string | null;
  /**
   * Event-type-specific payload (discriminated by event_type via allOf)
   */
  payload: {
    [k: string]: unknown;
  };
  /**
   * ISO 8601 timestamp
   */
  created_at: string;
}
