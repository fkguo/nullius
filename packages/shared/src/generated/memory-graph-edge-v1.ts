/* AUTO-GENERATED — DO NOT EDIT. Source: meta/schemas/ */
/**
 * Edge type identifier. Built-in types: triggered_by, confidence, resolved_by, produced, supersedes, generalizes, spawned_skill, co_change, failure_in. Additional domain-specific types are registered at runtime by consuming tracks and validated via the EdgeTypeRegistry (see EVO-20 §3.3).
 *
 * This interface was referenced by `MemoryGraphEdgeV1`'s JSON-Schema
 * via the `definition` "EdgeType".
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
/**
 * Payload for 'confidence' edge type (signal → gene/skill pair statistics)
 *
 * This interface was referenced by `MemoryGraphEdgeV1`'s JSON-Schema
 * via the `definition` "ConfidencePayload".
 */
export interface ConfidencePayload {
  success_count: number;
  fail_count: number;
  total: number;
  /**
   * (success+1)/(total+2)
   */
  laplace_p: number;
  last_outcome_ts: string;
}
/**
 * Payload for 'co_change' edge type (module → module co-modification tracking). Edge weight = min(co_occurrence_count * 0.1, 1.0) * decay_factor.
 *
 * This interface was referenced by `MemoryGraphEdgeV1`'s JSON-Schema
 * via the `definition` "CoChangePayload".
 */
export interface CoChangePayload {
  /**
   * Raw unbounded count of co-modifications. Edge weight is computed as min(count * 0.1, 1.0) * decay.
   */
  co_occurrence_count: number;
  last_co_change_ts: string;
}
/**
 * Payload for 'resolved_by' edge type
 *
 * This interface was referenced by `MemoryGraphEdgeV1`'s JSON-Schema
 * via the `definition` "ResolutionPayload".
 */
export interface ResolutionPayload {
  resolution_count: number;
  avg_quality: number;
  last_resolution_ts: string;
}
/**
 * This interface was referenced by `MemoryGraphEdgeV1`'s JSON-Schema
 * via the `definition` "SpawnedSkillPayload".
 */
export interface SpawnedSkillPayload {
  /**
   * Skill proposal ID (from EVO-12a)
   */
  proposal_id: string;
  /**
   * Generalization confidence at time of skill creation
   */
  confidence: number;
}
/**
 * This interface was referenced by `MemoryGraphEdgeV1`'s JSON-Schema
 * via the `definition` "EmptyPayload".
 */
export interface EmptyPayload {}
