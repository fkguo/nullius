/* AUTO-GENERATED — DO NOT EDIT. Source: meta/schemas/ */
/**
 * Node type identifier. Built-in types: signal, outcome, gene, capsule, skill, module, test, approval_pattern. Additional domain-specific types are registered at runtime by consuming tracks and validated via the NodeTypeRegistry (see EVO-20 §2.3). Non-built-in types must include a payload_schema_id in their payload for runtime validation.
 *
 * This interface was referenced by `MemoryGraphNodeV1`'s JSON-Schema
 * via the `definition` "NodeType".
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
/**
 * This interface was referenced by `MemoryGraphNodeV1`'s JSON-Schema
 * via the `definition` "SignalNodePayload".
 */
export interface SignalNodePayload {
  /**
   * FNV-1a hash of normalized+sorted signal set
   */
  signal_key: string;
  signals: string[];
  first_seen?: string;
  occurrence_count?: number;
}
/**
 * This interface was referenced by `MemoryGraphNodeV1`'s JSON-Schema
 * via the `definition` "GeneNodePayload".
 */
export interface GeneNodePayload {
  /**
   * Unique gene identifier
   */
  gene_id: string;
  name?: string;
  description?: string;
  /**
   * Signal patterns this gene matches
   */
  signals_match: string[];
  /**
   * Target scope (file type, module, etc.)
   */
  target_scope?: string;
  mutation_type?: "repair" | "optimize" | "innovate";
  /**
   * Validation commands to run after applying gene
   *
   * @minItems 1
   */
  validation?: [string, ...string[]];
  /**
   * Environment-specific expression modifiers
   */
  epigenetic_marks?: EpigeneticMark[];
  /**
   * How this gene was created
   */
  origin?: "manual" | "auto_gene" | "capsule_generalization" | "external";
}
/**
 * This interface was referenced by `MemoryGraphNodeV1`'s JSON-Schema
 * via the `definition` "EpigeneticMark".
 */
export interface EpigeneticMark {
  /**
   * Environment context key (platform, arch, node_version, etc.)
   */
  env_key: string;
  /**
   * Expression modifier (+0.05 on success, -0.1 on failure)
   */
  modifier: number;
  /**
   * Time-to-live in days
   */
  ttl_days?: number;
  created_at?: string;
  [k: string]: unknown;
}
/**
 * This interface was referenced by `MemoryGraphNodeV1`'s JSON-Schema
 * via the `definition` "CapsuleNodePayload".
 */
export interface CapsuleNodePayload {
  capsule_id: string;
  gene_id: string;
  /**
   * Trigger signals that activated this capsule
   */
  trigger: string[];
  confidence?: number;
  blast_radius?: {
    files_changed?: number;
    lines_added?: number;
    lines_removed?: number;
    [k: string]: unknown;
  };
  /**
   * H-18 ArtifactRef URI to capsule content. Full object resolved via artifact store.
   */
  artifact_uri?: string | null;
}
/**
 * This interface was referenced by `MemoryGraphNodeV1`'s JSON-Schema
 * via the `definition` "OutcomeNodePayload".
 */
export interface OutcomeNodePayload {
  success: boolean;
  quality_score?: number;
  error_delta?: number;
  validation_passed?: boolean;
  /**
   * Gate level applied (A0, A1, A2, etc.)
   */
  gate_level?: string;
}
/**
 * This interface was referenced by `MemoryGraphNodeV1`'s JSON-Schema
 * via the `definition` "SkillNodePayload".
 */
export interface SkillNodePayload {
  /**
   * Unique skill identifier
   */
  skill_id: string;
  /**
   * Skill name
   */
  name: string;
  trigger_description?: string;
  gate_level?: "A0" | "A1" | "A2";
  origin_gene_id?: string | null;
}
/**
 * This interface was referenced by `MemoryGraphNodeV1`'s JSON-Schema
 * via the `definition` "ModuleNodePayload".
 */
export interface ModuleNodePayload {
  /**
   * Module file path relative to repo root
   */
  path: string;
  /**
   * Package/component name
   */
  component?: string;
}
/**
 * This interface was referenced by `MemoryGraphNodeV1`'s JSON-Schema
 * via the `definition` "TestNodePayload".
 */
export interface TestNodePayload {
  test_id: string;
  /**
   * Test file path
   */
  path: string;
  test_type?: "unit" | "integration" | "e2e";
}
/**
 * This interface was referenced by `MemoryGraphNodeV1`'s JSON-Schema
 * via the `definition` "ApprovalPatternNodePayload".
 */
export interface ApprovalPatternNodePayload {
  /**
   * Approval pattern identifier
   */
  pattern_key: string;
  auto_approve?: boolean;
  min_confidence?: number;
}
