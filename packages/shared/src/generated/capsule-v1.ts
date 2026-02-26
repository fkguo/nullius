/* AUTO-GENERATED — DO NOT EDIT. Source: meta/schemas/ */
/**
 * Verified fix instance — a Gene applied to specific signals producing a specific outcome. Ported from Evolver GEP Capsule model (MIT, AutoGame Limited).
 */
export interface CapsuleV1 {
  /**
   * Unique capsule identifier (ID-01 compliant)
   */
  capsule_id: string;
  /**
   * Gene that produced this capsule
   */
  gene_id: string;
  /**
   * Signal set that triggered this capsule's creation
   *
   * @minItems 1
   */
  trigger: [string, ...string[]];
  /**
   * FNV-1a hash of normalized trigger signals. Required — computed via computeSignalKey(trigger) at capsule creation time.
   */
  signal_key: string;
  /**
   * Confidence score at creation time
   */
  confidence: number;
  blast_radius: BlastRadius;
  mutation_type?: "repair" | "optimize" | "innovate";
  validation_result?: ValidationResult;
  contract_guard_result?: ContractGuardResult;
  /**
   * Determined gate level for this capsule
   */
  gate_level?: "A0" | "A1" | "A2" | "reject";
  /**
   * List of files modified by this capsule
   */
  files_modified?: string[];
  /**
   * H-18 ArtifactRef URI to capsule content (diff, patch). Full ArtifactRef object resolved via artifact store.
   */
  artifact_uri?: string | null;
  run_id?: string | null;
  /**
   * Corresponding Memory Graph node ID (EVO-20)
   */
  node_id?: string | null;
  /**
   * If this capsule was generalized, the resulting gene_id
   */
  generalized_to_gene?: string | null;
  created_at: string;
}
/**
 * This interface was referenced by `CapsuleV1`'s JSON-Schema
 * via the `definition` "BlastRadius".
 */
export interface BlastRadius {
  files_changed: number;
  lines_added: number;
  lines_removed: number;
  severity?:
    | "within_limit"
    | "approaching_limit"
    | "exceeded"
    | "critical_overrun"
    | "hard_cap_breach";
  files_list?: string[];
  untracked_files?: string[];
}
/**
 * This interface was referenced by `CapsuleV1`'s JSON-Schema
 * via the `definition` "ValidationResult".
 */
export interface ValidationResult {
  all_passed: boolean;
  steps: {
    command: string;
    passed: boolean;
    stdout?: string;
    stderr?: string;
    error?: string;
  }[];
}
/**
 * This interface was referenced by `CapsuleV1`'s JSON-Schema
 * via the `definition` "ContractGuardResult".
 */
export interface ContractGuardResult {
  passed: boolean;
  violations: {
    rule_id: string;
    file: string;
    line?: number;
    message: string;
    severity: "error" | "warning";
    auto_fixable: boolean;
  }[];
  checked_rules: string[];
}
