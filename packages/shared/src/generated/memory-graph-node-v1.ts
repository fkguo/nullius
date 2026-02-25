/* AUTO-GENERATED — DO NOT EDIT. Source: meta/schemas/ */
/**
 * Node type identifier. Built-in types: signal, outcome, gene, capsule, skill, module, test, approval_pattern. Additional domain-specific types are registered at runtime by consuming tracks and validated via the NodeTypeRegistry (see EVO-20 §2.3). Non-built-in types must include a payload_schema_id in their payload for runtime validation.
 */
export type NodeType = string;

/**
 * Node in the Cross-Cycle Memory Graph. Core types support tool evolution; additional domain-specific types are registered at runtime by consuming tracks.
 */
export interface MemoryGraphNodeV1 {
  /**
   * Prefixed node ID (ID-01 compliant)
   */
  id: string;
  node_type: NodeType;
  /**
   * Which evolution track owns this node
   */
  track: "a" | "b" | "shared";
  /**
   * Type-specific node data (discriminated by node_type via allOf)
   */
  payload: {
    [k: string]: unknown;
  };
  created_at: string;
  updated_at: string;
  /**
   * Last decay weight recalculation timestamp
   */
  decay_ts?: string | null;
  /**
   * Current decay weight: 0.5^(age_days / half_life_days)
   */
  weight: number;
}
