/* AUTO-GENERATED — DO NOT EDIT. Source: meta/schemas/ */
/**
 * Provider-neutral deterministic bridge from computation_result_v1 into the writing/review substrate. Encodes routing, handoff seeds, and staging hints; worker selection and prose quality remain runtime responsibilities.
 */
export interface WritingReviewBridgeV1 {
  schema_version: 1;
  bridge_kind: "writing" | "review";
  run_id: string;
  objective_title: string;
  feedback_signal: "success" | "weak_signal" | "failure";
  decision_kind:
    | "capture_finding"
    | "refine_idea"
    | "branch_idea"
    | "downgrade_idea"
    | "literature_followup";
  summary: string;
  computation_result_uri: string;
  manifest_ref: ArtifactRefV1;
  produced_artifact_refs: ArtifactRefV11[];
  target: {
    task_kind: "draft_update" | "review";
    title: string;
    target_node_id: string;
    suggested_content_type:
      | "section_output"
      | "reviewer_report"
      | "revision_plan";
    seed_payload: {
      computation_result_uri: string;
      manifest_uri: string;
      summary: string;
      produced_artifact_uris: string[];
      finding_node_ids?: string[];
      draft_node_id?: string;
      issue_node_id?: string;
      target_draft_node_id?: string;
      source_artifact_name?: string;
      source_content_type?:
        | "section_output"
        | "reviewer_report"
        | "revision_plan";
    };
  };
  handoff?: {
    handoff_kind: "writing" | "review";
    target_node_id: string;
    payload:
      | {
          draft_node_id: string;
          /**
           * @minItems 1
           */
          finding_node_ids: [string, ...string[]];
        }
      | {
          issue_node_id: string;
          target_draft_node_id?: string;
        };
  };
  context: {
    draft_context_mode: "seeded_draft" | "existing_draft";
    draft_source_artifact_name?: string;
    draft_source_content_type?:
      | "section_output"
      | "reviewer_report"
      | "revision_plan";
    review_source_artifact_name?: string;
    review_source_content_type?: "reviewer_report" | "revision_plan";
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
