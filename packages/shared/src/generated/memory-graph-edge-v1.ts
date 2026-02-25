/* AUTO-GENERATED — DO NOT EDIT. Source: meta/schemas/ */
/**
 * Edge type identifier. Built-in types: triggered_by, confidence, resolved_by, produced, supersedes, generalizes, spawned_skill, co_change, failure_in. Additional domain-specific types are registered at runtime by consuming tracks and validated via the EdgeTypeRegistry (see EVO-20 §3.3).
 */
export type EdgeType = string;

/**
 * Edge in the Cross-Cycle Memory Graph. Connects nodes with typed, weighted, decay-aware relationships.
 */
export interface MemoryGraphEdgeV1 {
  /**
   * Prefixed edge ID (ID-01 compliant)
   */
  id: string;
  edge_type: EdgeType;
  /**
   * Source node ID
   */
  source_id: string;
  /**
   * Target node ID
   */
  target_id: string;
  /**
   * Edge-type-specific metadata (discriminated by edge_type via allOf)
   */
  payload: {
    [k: string]: unknown;
  };
  created_at: string;
  /**
   * Edge weight [0,1]. For co_change: min(co_occurrence_count * 0.1, 1.0) * decay. For confidence: laplace_p * decay. For others: decay only.
   */
  weight: number;
}
