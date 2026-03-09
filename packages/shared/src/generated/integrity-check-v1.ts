/* AUTO-GENERATED — DO NOT EDIT. Source: meta/schemas/ */
/**
 * Definition of a single integrity check that can be executed against a research artifact. Domain-agnostic interface; domain-specific checks are provided by domain packs.
 */
export interface IntegrityCheckV1 {
  schema_version: 1;
  /**
   * Unique identifier. Format: '{domain}_{check_name}' or '{domain}_{check_name}.{sub_check}' (e.g., 'theory_cross_check.invariant_consistency').
   */
  check_id: string;
  /**
   * Human-readable name.
   */
  name: string;
  /**
   * Domain this check belongs to (e.g., 'hep-th', 'cond-mat', 'mathematics'). Use '*' for domain-agnostic checks.
   */
  domain: string;
  /**
   * Default severity. 'blocking' means failure prevents publication (at A5 gate). 'advisory' means informational only.
   */
  severity: "blocking" | "advisory";
  /**
   * What this check verifies.
   */
  description: string;
  /**
   * Whether severity can be overridden per run_card.
   */
  configurable?: boolean;
  /**
   * Phase-specific severity overrides. Key is phase name (e.g., 'exploration', 'A5'). Value is severity for that phase.
   */
  phase_overrides?: {
    [k: string]: "blocking" | "advisory" | "disabled";
  };
  /**
   * External dependencies for this check.
   */
  requires?: {
    /**
     * MCP tools needed (e.g., ['literature_search', 'citation_lookup']).
     */
    tools?: string[];
    /**
     * Databases needed (e.g., ['openalex', 'zotero']).
     */
    databases?: string[];
    /**
     * Computation packages needed (e.g., ['Mathematica'], ['Lean4'], ['NumPy']).
     */
    computation_packages?: string[];
    [k: string]: unknown;
  };
  /**
   * JSON Schema for the expected input context (CheckContext.domain_config).
   */
  input_schema?: {
    [k: string]: unknown;
  };
  /**
   * Maximum execution time in milliseconds (default 5 minutes).
   */
  timeout_ms?: number;
  /**
   * Tags for categorization (e.g., ['symmetry', 'consistency', 'novelty']).
   */
  tags?: string[];
}
