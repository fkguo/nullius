/* AUTO-GENERATED — DO NOT EDIT. Source: meta/schemas/ */
/**
 * Provider-neutral, artifact-backed verification target. Anchors a stable subject identity to existing artifacts so later checks, verdicts, and coverage can reference the same subject without inventing a second project-state authority.
 */
export interface VerificationSubjectV1 {
  schema_version: 1;
  subject_id: string;
  subject_kind:
    | "claim"
    | "result"
    | "deliverable"
    | "acceptance_test"
    | "reference_action"
    | "forbidden_proxy"
    | "comparison_target";
  run_id: string;
  title: string;
  description?: string;
  /**
   * @minItems 1
   */
  source_refs: [ArtifactRefV1, ...ArtifactRefV1[]];
  linked_identifiers?: LinkedIdentifier[];
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
 * This interface was referenced by `VerificationSubjectV1`'s JSON-Schema
 * via the `definition` "LinkedIdentifier".
 */
export interface LinkedIdentifier {
  id_kind: string;
  id_value: string;
}
