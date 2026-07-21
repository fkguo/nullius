/* AUTO-GENERATED — DO NOT EDIT. Source: meta/schemas/ */
/**
 * Nullius-generated input to a decisive checker. It records structured-output URI/path targets, the declared semantic surface, checker/runtime bytes, and the sanitized environment. Content hashes and adjacent production snapshots are bound by the outer validation-chain receipt. This request does not prove that the checker read an output or provide a syscall/import/installed-byte dependency closure.
 */
export interface ValidationCheckerRequestV1 {
  schema_version: 1;
  run_id: string;
  subject_id: string;
  check_kind: string;
  quantity_id: string;
  layer_id: string;
  /**
   * @minItems 1
   */
  reference_provenance: [
    {
      reference_id: string;
      uri: string;
      sha256: string;
    },
    ...{
      reference_id: string;
      uri: string;
      sha256: string;
    }[],
  ];
  /**
   * @minItems 1
   */
  disputed_dimensions: [string, ...string[]];
  /**
   * @minItems 1
   */
  required_negative_control_ids: [string, ...string[]];
  /**
   * @minItems 1
   */
  output_targets: [
    {
      uri: string;
      path: string;
    },
    ...{
      uri: string;
      path: string;
    }[],
  ];
  checker_ref: ArtifactRefV1;
  checker_helper_refs: ArtifactRefV11[];
  checker_runtime: NativeRuntimeIdentityV1;
  checker_environment: SanitizedCheckerEnvironmentV1;
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
export interface NativeRuntimeIdentityV1 {
  requested_token: string;
  canonical_path: string;
  sha256: string;
  size_bytes: number;
  executable_format: "elf" | "mach_o" | "pe";
}
export interface SanitizedCheckerEnvironmentV1 {
  policy: "nullius_checker_sanitized_v1";
  variables: {
    [k: string]: string;
  };
  sha256: string;
}
