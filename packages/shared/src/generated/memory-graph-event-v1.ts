/* AUTO-GENERATED — DO NOT EDIT. Source: meta/schemas/ */
/**
 * Event type enumeration (ported from Evolver)
 *
 * This interface was referenced by `MemoryGraphEventV1`'s JSON-Schema
 * via the `definition` "EventType".
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
 * This interface was referenced by `MemoryGraphEventV1`'s JSON-Schema
 * via the `definition` "OutcomePayload".
 */
export type OutcomePayload = {
  [k: string]: unknown;
};

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
/**
 * This interface was referenced by `MemoryGraphEventV1`'s JSON-Schema
 * via the `definition` "SignalPayload".
 */
export interface SignalPayload {
  type: "signal";
  /**
   * List of observed signals
   */
  signals: string[];
  /**
   * FNV-1a hash of normalized+sorted signal set
   */
  signal_key: string;
}
/**
 * This interface was referenced by `MemoryGraphEventV1`'s JSON-Schema
 * via the `definition` "HypothesisPayload".
 */
export interface HypothesisPayload {
  type: "hypothesis";
  gene_id: string;
  signals: string[];
  signal_key: string;
  /**
   * Why this gene was selected (memory_preferred, signal_match, drift, auto_gene)
   */
  selection_reason?: string;
}
/**
 * This interface was referenced by `MemoryGraphEventV1`'s JSON-Schema
 * via the `definition` "AttemptPayload".
 */
export interface AttemptPayload {
  type: "attempt";
  gene_id: string;
  /**
   * Mutation type (EVO-21 extension)
   */
  mutation_type?: "repair" | "optimize" | "innovate";
}
/**
 * This interface was referenced by `MemoryGraphEventV1`'s JSON-Schema
 * via the `definition` "ConfidenceEdgePayload".
 */
export interface ConfidenceEdgePayload {
  type: "confidence_edge";
  signal_key: string;
  gene_id: string;
  success: boolean;
}
/**
 * This interface was referenced by `MemoryGraphEventV1`'s JSON-Schema
 * via the `definition` "ConfidenceGeneOutcomePayload".
 */
export interface ConfidenceGeneOutcomePayload {
  type: "confidence_gene_outcome";
  gene_id: string;
  outcome_score: number;
}
/**
 * This interface was referenced by `MemoryGraphEventV1`'s JSON-Schema
 * via the `definition` "ExternalCandidatePayload".
 */
export interface ExternalCandidatePayload {
  type: "external_candidate";
  /**
   * Source of external candidate (e.g., hub, manual)
   */
  source: string;
  /**
   * External gene/capsule candidate data
   */
  candidate: {
    [k: string]: unknown;
  };
}
/**
 * This interface was referenced by `MemoryGraphEventV1`'s JSON-Schema
 * via the `definition` "BlastRadiusSummary".
 */
export interface BlastRadiusSummary {
  files_changed?: number;
  lines_added?: number;
  lines_removed?: number;
  severity?:
    | "within_limit"
    | "approaching_limit"
    | "exceeded"
    | "critical_overrun"
    | "hard_cap_breach";
}
