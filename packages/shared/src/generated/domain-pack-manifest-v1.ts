/* AUTO-GENERATED — DO NOT EDIT. Source: meta/schemas/ */
/**
 * Manifest file for a domain pack. Describes the pack's integrity checks, RDI scoring configuration, reproducibility settings, and strategy extensions for a specific research domain.
 */
export interface DomainPackManifestV1 {
  schema_version: 1;
  /**
   * Unique identifier for this domain pack (e.g., 'cond-mat-integrity').
   */
  pack_id: string;
  /**
   * Human-readable name (e.g., 'Theory Research Integrity Pack').
   */
  name: string;
  /**
   * SemVer version of this pack.
   */
  version: string;
  /**
   * Research domain this pack applies to (e.g., 'hep-th', 'cond-mat', 'mathematics'). Must match ResearchStrategy.domain and IntegrityReport.domain.
   */
  domain: string;
  /**
   * Description of what this pack checks.
   */
  description?: string;
  /**
   * Author or organization.
   */
  author?: string;
  /**
   * License identifier (e.g., 'MIT').
   */
  license?: string;
  /**
   * List of integrity checks provided by this pack.
   *
   * @minItems 1
   */
  checks: [
    {
      /**
       * Check identifier, must match IntegrityCheck.check_id.
       */
      check_id: string;
      /**
       * Human-readable name.
       */
      name: string;
      /**
       * Default severity.
       */
      severity_default: "blocking" | "advisory";
      /**
       * Whether severity can be overridden.
       */
      configurable?: boolean;
      /**
       * Module path or function name for loading the check implementation.
       */
      entry_point?: string;
      /**
       * Sub-checks within this check (e.g., cross_check has ward_identity, gauge_invariance, etc.).
       */
      sub_checks?: {
        /**
         * Sub-check suffix (e.g., 'invariant_consistency' for 'theory_cross_check.invariant_consistency').
         */
        sub_check_id: string;
        name: string;
        severity_default: "blocking" | "advisory";
        [k: string]: unknown;
      }[];
      [k: string]: unknown;
    },
    ...{
      /**
       * Check identifier, must match IntegrityCheck.check_id.
       */
      check_id: string;
      /**
       * Human-readable name.
       */
      name: string;
      /**
       * Default severity.
       */
      severity_default: "blocking" | "advisory";
      /**
       * Whether severity can be overridden.
       */
      configurable?: boolean;
      /**
       * Module path or function name for loading the check implementation.
       */
      entry_point?: string;
      /**
       * Sub-checks within this check (e.g., cross_check has ward_identity, gauge_invariance, etc.).
       */
      sub_checks?: {
        /**
         * Sub-check suffix (e.g., 'invariant_consistency' for 'theory_cross_check.invariant_consistency').
         */
        sub_check_id: string;
        name: string;
        severity_default: "blocking" | "advisory";
        [k: string]: unknown;
      }[];
      [k: string]: unknown;
    }[],
  ];
  /**
   * External dependencies needed by this pack.
   */
  dependencies?: {
    /**
     * MCP tools required by checks in this pack.
     */
    tools?: string[];
    /**
     * External databases required.
     */
    databases?: string[];
    /**
     * Computation software required.
     */
    computation_packages?: string[];
    /**
     * npm package dependencies with version ranges.
     */
    npm_packages?: {
      [k: string]: string;
    };
    [k: string]: unknown;
  };
  /**
   * Configuration options for this pack.
   */
  configuration?: {
    [k: string]: {
      type: "string" | "number" | "boolean" | "array" | "object";
      description: string;
      default?: unknown;
      required?: boolean;
      [k: string]: unknown;
    };
  };
  compatibility?: {
    /**
     * Minimum integrity framework version required (SemVer range).
     */
    integrity_framework_version?: string;
    /**
     * Minimum REP SDK version required (SemVer range).
     */
    rep_sdk_version?: string;
    [k: string]: unknown;
  };
  /**
   * RDI scoring configuration: method taxonomy for generality, problem taxonomy for significance, and reference values. If omitted, REP SDK uses built-in defaults (method_class fallback 0.5, significance fallback 0.5).
   */
  scoring_config?: {
    /**
     * Maps method approach strings to generality scores (0-1). Example: { 'lattice_qcd': 0.90, 'fixed_order_pqcd': 0.70 }.
     */
    method_taxonomy?: {
      [k: string]: number;
    };
    /**
     * Problem significance classification for the significance RDI dimension.
     */
    problem_taxonomy?: {
      problem_classes?: {
        [k: string]: {
          base_significance: number;
          description?: string;
          examples?: string[];
          [k: string]: unknown;
        };
      };
      [k: string]: unknown;
    };
    /**
     * Normalization denominator for result_breadth in generality scoring.
     */
    reference_metric_count?: number;
    /**
     * Normalization denominator for assumption_lightness in generality scoring.
     */
    reference_assumption_count?: number;
    /**
     * Optional RDI weight overrides. Must sum to 1.0 (enforced by SDK runtime validator; not expressible in JSON Schema alone). Values outside allowed bounds are rejected at validation time.
     */
    rdi_weight_overrides?: {
      novelty?: number;
      generality?: number;
      significance?: number;
      citation_impact?: number;
      [k: string]: unknown;
    };
    /**
     * External literature service for novelty scoring. Known values: 'inspire' (HEP), 'crossref' (general academic), 'openalex' (general academic), 'semantic_scholar', 'zbmath' (mathematics). If omitted, novelty uses local corpus only.
     */
    literature_service_id?: string;
    /**
     * Automatic taxonomy expansion configuration. When enabled, taxonomy_miss diagnostics are accumulated and new entries are proposed (and optionally auto-approved) to grow method_taxonomy and problem_taxonomy over time. Default: disabled.
     */
    taxonomy_expansion?: {
      /**
       * Whether automatic taxonomy expansion is active.
       */
      enabled: boolean;
      /**
       * Minimum distinct taxonomy_miss events with a common pattern before a proposal is generated.
       */
      min_miss_count?: number;
      /**
       * Confidence threshold at or above which proposals are auto-committed without human review.
       */
      auto_approve_threshold?: number;
      /**
       * When true, all proposals require explicit human approval regardless of confidence score.
       */
      require_human_review?: boolean;
      /**
       * Maximum number of pending (unapproved) proposals retained. Oldest proposals are discarded when exceeded.
       */
      max_pending_proposals?: number;
      [k: string]: unknown;
    };
    [k: string]: unknown;
  };
  /**
   * Novelty scoring configuration: fingerprint vector construction and literature record extraction adapters. If omitted, REP SDK uses the default 96-dim fingerprint with title-only fallback for external records (see EVO-17 Section 4.3.1).
   */
  fingerprint_config?: {
    /**
     * Pre-computed method embedding vectors (maps method approach to fixed-length vector).
     */
    method_vectors?: {
      [k: string]: number[];
    };
    /**
     * Vocabulary of observable types for one-hot encoding in fingerprint. Also used by result_breadth to deduplicate metric keys into distinct observable classes.
     */
    observable_vocabulary?: string[];
    /**
     * Adapter specification for extracting fingerprint components from LiteratureRecord.metadata. Maps service-specific metadata fields to the 96-dim fingerprint components.
     */
    literature_record_adapter?: {
      /**
       * Metadata field name containing the method/approach (mapped to method_embedding). Example: 'arxiv_categories' for INSPIRE.
       */
      method_field?: string;
      /**
       * Metadata field name containing result type info (mapped to result_type_encoding). Example: 'keywords' for CrossRef.
       */
      result_type_field?: string;
      /**
       * Metadata field name containing parameter range info. Example: 'custom_metadata.energy_range' for INSPIRE.
       */
      param_range_field?: string;
      /**
       * Metadata field name containing headline results. Example: 'abstract' for CrossRef (text extraction).
       */
      headline_field?: string;
      [k: string]: unknown;
    };
    [k: string]: unknown;
  };
  /**
   * Reproducibility verification configuration: computation backends and verification modes for the domain.
   */
  reproducibility_config?: {
    /**
     * Available computation backends for reproducibility verification.
     */
    backends?: {
      name: string;
      version_constraint?: string;
      /**
       * How to verify reproducibility. Recommended values: 'exact_match', 'statistical', 'formal_proof_check', 'not_applicable'.
       */
      verification_mode?: string;
      [k: string]: unknown;
    }[];
    [k: string]: unknown;
  };
  /**
   * Domain-specific strategy field constraints. Defines which additional fields the domain expects in ResearchStrategy.method (via additionalProperties) and their validation rules.
   */
  strategy_extensions?: {
    /**
     * Additional method fields expected by this domain. Example (HEP): { 'order': { type: 'string', recommended_values: ['LO', 'NLO', 'NNLO'] }, 'gauge': { type: 'string' }, 'renormalization_scheme': { type: 'string' } }.
     */
    method_fields?: {
      [k: string]: {
        type?: string;
        description?: string;
        recommended_values?: string[];
        required?: boolean;
        [k: string]: unknown;
      };
    };
    [k: string]: unknown;
  };
}
