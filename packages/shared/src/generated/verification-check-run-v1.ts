/* AUTO-GENERATED — DO NOT EDIT. Source: meta/schemas/ */
/**
 * Provider-neutral record of one executed verification check on one verification subject. This artifact stays generic across domains and methods: the checked kind is an open string, but decisive status, evidence refs, executor provenance, and confidence stay typed and fail-closed.
 */
export interface VerificationCheckRunV1 {
  schema_version: 1;
  check_run_id: string;
  run_id: string;
  subject_id: string;
  subject_ref: ArtifactRefV1;
  check_kind: string;
  check_role: "decisive" | "supporting" | "diagnostic";
  status: "passed" | "failed" | "inconclusive" | "blocked";
  summary: string;
  input_artifact_refs?: ArtifactRefV11[];
  output_artifact_refs?: ArtifactRefV12[];
  /**
   * @minItems 1
   */
  evidence_refs: [ArtifactRefV13, ...ArtifactRefV13[]];
  executor_provenance: ExecutorProvenance;
  confidence: Confidence;
  metrics?: MetricObservation[];
  notes?: string;
  started_at: string;
  finished_at: string;
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
/**
 * Content-addressed reference to a research artifact. Used by integrity reports, research outcomes, and events to point at specific versioned artifacts.
 */
export interface ArtifactRefV13 {
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
 * This interface was referenced by `VerificationCheckRunV1`'s JSON-Schema
 * via the `definition` "ExecutorProvenance".
 */
export interface ExecutorProvenance {
  component: string;
  surface: string;
  executor_kind?: string;
}
/**
 * This interface was referenced by `VerificationCheckRunV1`'s JSON-Schema
 * via the `definition` "Confidence".
 */
export interface Confidence {
  level: "low" | "medium" | "high";
  score?: number;
}
/**
 * This interface was referenced by `VerificationCheckRunV1`'s JSON-Schema
 * via the `definition` "MetricObservation".
 */
export interface MetricObservation {
  metric_name: string;
  metric_value: number | string | boolean;
  unit?: string;
}
