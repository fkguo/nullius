/* AUTO-GENERATED — DO NOT EDIT. Source: meta/schemas/ */
/**
 * Provider-neutral subject-level verification verdict. Aggregates check-run evidence without inlining runtime state, and makes missing decisive checks explicit and machine-visible instead of leaving them in prose only.
 */
export interface VerificationSubjectVerdictV1 {
  schema_version: 1;
  verdict_id: string;
  run_id: string;
  subject_id: string;
  subject_ref: ArtifactRefV1;
  status: "verified" | "partial" | "failed" | "blocked" | "not_attempted";
  summary: string;
  check_run_refs: ArtifactRefV11[];
  missing_decisive_checks: MissingDecisiveCheck[];
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
 * This interface was referenced by `VerificationSubjectVerdictV1`'s JSON-Schema
 * via the `definition` "MissingDecisiveCheck".
 */
export interface MissingDecisiveCheck {
  check_kind: string;
  reason: string;
  priority: "low" | "medium" | "high";
}
