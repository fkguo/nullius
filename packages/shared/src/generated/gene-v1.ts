/* AUTO-GENERATED — DO NOT EDIT. Source: meta/schemas/ */
/**
 * Reusable repair/optimization/innovation strategy template. Ported from Evolver GEP Gene model (MIT, AutoGame Limited).
 */
export interface GeneV1 {
  /**
   * Unique gene identifier
   */
  gene_id: string;
  /**
   * Human-readable gene name
   */
  name: string;
  /**
   * Detailed description of what this gene does
   */
  description?: string;
  /**
   * Signal patterns this gene matches. Supports exact, prefix (*), suffix (*), and contains (*...*) matching.
   *
   * @minItems 1
   */
  signals_match: [string, ...string[]];
  /**
   * File/module scope this gene targets (e.g., '*.ts', 'packages/shared/**')
   */
  target_scope: string;
  /**
   * Mutation type: repair (fix errors), optimize (improve quality), innovate (architectural change)
   */
  mutation_type: "repair" | "optimize" | "innovate";
  /**
   * Validation commands to run after applying gene. Only node/npm/npx allowed. At least one command required.
   *
   * @minItems 1
   */
  validation: [string, ...string[]];
  /**
   * How this gene was created
   */
  origin: "manual" | "auto_gene" | "capsule_generalization" | "external";
  /**
   * Maximum files this gene is allowed to modify
   */
  max_files?: number;
  constraint_policy?: ConstraintPolicy;
  /**
   * Environment-specific expression modifiers
   *
   * @maxItems 10
   */
  epigenetic_marks?:
    | []
    | [EpigeneticMark]
    | [EpigeneticMark, EpigeneticMark]
    | [EpigeneticMark, EpigeneticMark, EpigeneticMark]
    | [EpigeneticMark, EpigeneticMark, EpigeneticMark, EpigeneticMark]
    | [
        EpigeneticMark,
        EpigeneticMark,
        EpigeneticMark,
        EpigeneticMark,
        EpigeneticMark,
      ]
    | [
        EpigeneticMark,
        EpigeneticMark,
        EpigeneticMark,
        EpigeneticMark,
        EpigeneticMark,
        EpigeneticMark,
      ]
    | [
        EpigeneticMark,
        EpigeneticMark,
        EpigeneticMark,
        EpigeneticMark,
        EpigeneticMark,
        EpigeneticMark,
        EpigeneticMark,
      ]
    | [
        EpigeneticMark,
        EpigeneticMark,
        EpigeneticMark,
        EpigeneticMark,
        EpigeneticMark,
        EpigeneticMark,
        EpigeneticMark,
        EpigeneticMark,
      ]
    | [
        EpigeneticMark,
        EpigeneticMark,
        EpigeneticMark,
        EpigeneticMark,
        EpigeneticMark,
        EpigeneticMark,
        EpigeneticMark,
        EpigeneticMark,
        EpigeneticMark,
      ]
    | [
        EpigeneticMark,
        EpigeneticMark,
        EpigeneticMark,
        EpigeneticMark,
        EpigeneticMark,
        EpigeneticMark,
        EpigeneticMark,
        EpigeneticMark,
        EpigeneticMark,
        EpigeneticMark,
      ];
  /**
   * Current confidence score (Laplace-smoothed success rate)
   */
  confidence?: number;
  total_uses?: number;
  success_count?: number;
  last_used?: string | null;
  created_at: string;
  /**
   * Corresponding Memory Graph node ID (EVO-20)
   */
  node_id?: string | null;
}
/**
 * This interface was referenced by `GeneV1`'s JSON-Schema
 * via the `definition` "ConstraintPolicy".
 */
export interface ConstraintPolicy {
  max_files?: number;
  include_prefixes?: string[];
  exclude_prefixes?: string[];
  include_extensions?: string[];
  /**
   * Paths that must not be modified
   */
  forbidden_paths?: string[];
  /**
   * Paths requiring elevated review
   */
  critical_paths?: string[];
}
/**
 * This interface was referenced by `GeneV1`'s JSON-Schema
 * via the `definition` "EpigeneticMark".
 */
export interface EpigeneticMark {
  /**
   * Environment context (platform_arch_nodeVersion)
   */
  env_key: string;
  /**
   * +0.05 on success, -0.1 on failure
   */
  modifier: number;
  ttl_days: number;
  created_at: string;
}
