/* AUTO-GENERATED — DO NOT EDIT. Source: meta/schemas/ */
/**
 * Minimal generic higher-conclusion closeout artifact created after an A5 approval is granted on canonical verification truth. This is a local control-plane artifact, not a REP publish payload.
 */
export interface FinalConclusionsV1 {
  schema_version: 1;
  run_id: string;
  approval_id: string;
  gate_id: "A5";
  source_result_ref: ArtifactRefV1;
  approval_packet_ref: ArtifactRefV11;
  verification_summary: {
    decision: "pass";
    summary: string;
  };
  summary: string;
  created_at: string;
  provenance: {
    orchestrator_component: string;
    trigger_surface: string;
    approved_via: string;
    note?: string;
  };
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
