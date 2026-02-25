/* AUTO-GENERATED — DO NOT EDIT. Source: meta/schemas/ */
/**
 * A verified research result produced by applying a ResearchStrategy. Content-addressed via SHA-256 of RFC 8785 (JCS) canonical JSON.
 */
export interface ResearchOutcomeV1 {
  schema_version: 1;
  /**
   * Content-addressed identifier: SHA-256 hex digest of RFC 8785 (JCS) canonical JSON of this object excluding outcome_id itself.
   */
  outcome_id: string;
  /**
   * Stable identity across revisions (analogous to arXiv paper ID). Generated on first publication, inherited by all subsequent versions within the same research line.
   */
  lineage_id: string;
  /**
   * Version number within the lineage, monotonically increasing. First publication is version 1.
   */
  version: number;
  /**
   * strategy_id of the ResearchStrategy that produced this outcome.
   */
  strategy_ref: string;
  /**
   * Verification status. 'verified' means passed RDI gate. 'superseded' means a newer outcome replaced this one.
   */
  status: "pending" | "verified" | "rejected" | "superseded";
  /**
   * Key-value map of research results (physical quantities, derived relations, proven statements, classification results, or other domain-specific outcomes).
   */
  metrics: {
    [k: string]: {
      /**
       * The computed value (number, string expression, or array).
       */
      value: {
        [k: string]: unknown;
      };
      /**
       * Numerical/statistical uncertainty.
       */
      uncertainty?: number;
      /**
       * Unit of measurement. Omit for dimensionless quantities. Interpretation is domain-pack-defined.
       */
      unit?: string;
      /**
       * How this quantity was computed.
       */
      method?: string;
      [k: string]: unknown;
    };
  };
  /**
   * Evidence pointers to computation artifacts (ArtifactRef V1).
   */
  artifacts: ArtifactRefV1[];
  /**
   * Content-addressed ID of the IntegrityReport for this outcome.
   */
  integrity_report_ref?: string;
  /**
   * Content-addressed ID of the DeviationReport from reproducibility verification.
   */
  reproducibility_report_ref?: string;
  /**
   * Reproducibility verification status. 'verified': independent re-computation agrees. 'pending': verification not yet performed. 'failed': re-computation disagrees. 'not_applicable': outcome type does not support numerical reproducibility (e.g., formal proofs, theoretical arguments).
   */
  reproducibility_status?: "verified" | "pending" | "failed" | "not_applicable";
  /**
   * Overall confidence in this outcome (0-1).
   */
  confidence?: number;
  /**
   * RDI (Research Desirability Index) scores. Only populated after RDI evaluation.
   */
  rdi_scores?: {
    /**
     * Whether this outcome passed the RDI fail-closed gate.
     */
    gate_passed: boolean;
    /**
     * Novelty score (0-1). Higher means more novel.
     */
    novelty: number;
    /**
     * Methodological generality score (0-1). Broader method applicability = higher.
     */
    generality: number;
    /**
     * Problem significance score (0-1). How central is the addressed problem to the field.
     */
    significance: number;
    /**
     * Local citation impact score (0-1).
     */
    citation_impact: number;
    /**
     * Composite ranking score: w_n*novelty + w_g*generality + w_s*significance + w_c*citation_impact.
     */
    rank_score: number;
    [k: string]: unknown;
  };
  /**
   * Parameter space where this result is valid.
   */
  applicability_range?: {
    [k: string]: {
      min?: number;
      max?: number;
      unit?: string;
      [k: string]: unknown;
    };
  };
  /**
   * Provenance: who/what produced this outcome.
   */
  produced_by: {
    /**
     * Identifier of the agent/tool that produced this outcome.
     */
    agent_id: string;
    /**
     * Run in which this outcome was produced.
     */
    run_id?: string;
    /**
     * Versions of tools used (e.g., {'FeynCalc': '10.0.0'}).
     */
    tool_versions?: {
      [k: string]: string;
    };
    [k: string]: unknown;
  };
  /**
   * ISO 8601 UTC Z timestamp of creation.
   */
  created_at: string;
  /**
   * outcome_id of the previous version this outcome supersedes (if version > 1). Forms the explicit revision chain.
   */
  supersedes?: string;
  /**
   * outcome_id of the outcome that supersedes this one (if status is 'superseded').
   */
  superseded_by?: string;
  tags?: string[];
}
/**
 * Content-addressed reference to a research artifact. Used by integrity reports, research outcomes, and events to point at specific versioned artifacts.
 */
export interface ArtifactRefV1 {
  /**
   * URI of the artifact. Format: 'rep://<run_id>/<artifact_path>' for local, or absolute URI for remote.
   */
  uri: string;
  /**
   * Artifact kind (e.g., 'strategy', 'outcome', 'computation_result', 'integrity_report'). Optional for forward compatibility.
   */
  kind?: string;
  /**
   * Schema version of the referenced artifact.
   */
  schema_version?: number;
  /**
   * SHA-256 hex digest of the artifact content. Used for integrity verification and content addressing.
   */
  sha256: string;
  /**
   * Size of the artifact in bytes.
   */
  size_bytes?: number;
  /**
   * Agent or component that produced this artifact.
   */
  produced_by?: string;
  /**
   * ISO 8601 UTC Z timestamp of artifact creation.
   */
  created_at?: string;
}
