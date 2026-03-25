/* AUTO-GENERATED — DO NOT EDIT. Source: meta/schemas/ */
/**
 * Provider-neutral run-level coverage summary over verification subjects and subject verdicts. This artifact tracks what is covered, what remains open, and which decisive checks are still missing without reusing computation-only reproducibility contracts as generic verification authority.
 */
export interface VerificationCoverageV1 {
  schema_version: 1;
  coverage_id: string;
  run_id: string;
  generated_at: string;
  subject_refs: ArtifactRefV1[];
  subject_verdict_refs: ArtifactRefV11[];
  summary: CoverageSummary;
  missing_decisive_checks: CoverageGap[];
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
/**
 * Content-addressed reference to a research artifact. Used by integrity reports, research outcomes, and events to point at specific versioned artifacts.
 */
export interface ArtifactRefV11 {
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
/**
 * This interface was referenced by `VerificationCoverageV1`'s JSON-Schema
 * via the `definition` "CoverageSummary".
 */
export interface CoverageSummary {
  subjects_total: number;
  subjects_verified: number;
  subjects_partial: number;
  subjects_failed: number;
  subjects_blocked: number;
  subjects_not_attempted: number;
}
/**
 * This interface was referenced by `VerificationCoverageV1`'s JSON-Schema
 * via the `definition` "CoverageGap".
 */
export interface CoverageGap {
  subject_id: string;
  subject_ref: ArtifactRefV12;
  check_kind: string;
  reason: string;
  priority: "low" | "medium" | "high";
}
/**
 * Content-addressed reference to a research artifact. Used by integrity reports, research outcomes, and events to point at specific versioned artifacts.
 */
export interface ArtifactRefV12 {
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
