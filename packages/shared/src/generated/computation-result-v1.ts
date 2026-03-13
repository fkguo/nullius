/* AUTO-GENERATED — DO NOT EDIT. Source: meta/schemas/ */
/**
 * Canonical provider-neutral outcome artifact for an approved computation execution. Records execution status, produced artifacts, and deterministic lowering into the single-user research-loop substrate.
 */
export interface ComputationResultV1 {
  schema_version: 1;
  run_id: string;
  objective_title: string;
  manifest_ref: ArtifactRefV1;
  execution_status: "completed" | "failed";
  produced_artifact_refs: ArtifactRefV11[];
  started_at: string;
  finished_at: string;
  summary: string;
  feedback_lowering: {
    signal: "success" | "weak_signal" | "failure";
    decision_kind:
      | "capture_finding"
      | "refine_idea"
      | "branch_idea"
      | "downgrade_idea"
      | "literature_followup";
    priority_change: "raise" | "keep" | "lower";
    prune_candidate: boolean;
    target_task_kind: "finding" | "idea" | "literature";
    target_node_id: string;
    handoff_kind?: "feedback";
    backtrack_to_task_kind?: "idea" | "literature";
    backtrack_to_node_id?: string;
  };
  /**
   * @minItems 1
   */
  next_actions: [
    {
      action_kind:
        | "capture_finding"
        | "refine_idea"
        | "branch_idea"
        | "downgrade_idea"
        | "literature_followup";
      task_kind: "finding" | "idea" | "literature";
      title: string;
      target_node_id: string;
      reason: string;
      handoff_kind?: "feedback";
    },
    ...{
      action_kind:
        | "capture_finding"
        | "refine_idea"
        | "branch_idea"
        | "downgrade_idea"
        | "literature_followup";
      task_kind: "finding" | "idea" | "literature";
      title: string;
      target_node_id: string;
      reason: string;
      handoff_kind?: "feedback";
    }[],
  ];
  followup_bridge_refs: ArtifactRefV12[];
  executor_provenance: {
    orchestrator_component: string;
    execution_surface: string;
    approval_gate: "A3";
    step_tools: ("mathematica" | "julia" | "python" | "bash")[];
    step_ids: string[];
  };
  failure_reason?: string;
  workspace_feedback: {
    policy_mode: "interactive" | "autonomous";
    workspace: {
      schema_version: 1;
      workspace_id: string;
      primary_question_id: string;
      nodes: {
        node_id: string;
        kind:
          | "question"
          | "idea"
          | "evidence_set"
          | "compute_attempt"
          | "finding"
          | "draft_section"
          | "review_issue"
          | "decision";
        title: string;
        metadata?: {
          [k: string]: unknown;
        };
      }[];
      edges: {
        edge_id: string;
        kind:
          | "depends_on"
          | "supports"
          | "produces"
          | "revises"
          | "addresses"
          | "branches_to"
          | "backtracks_to";
        from_node_id: string;
        to_node_id: string;
        rationale?: string | null;
      }[];
      created_at: string;
      updated_at: string;
    };
    tasks: {
      task_id: string;
      kind:
        | "literature"
        | "idea"
        | "compute"
        | "evidence_search"
        | "finding"
        | "draft_update"
        | "review";
      title: string;
      target_node_id: string;
      source: "user" | "agent" | "system";
      actor_id: string | null;
      metadata?: {
        [k: string]: unknown;
      };
      status: "pending" | "active" | "completed" | "blocked" | "cancelled";
      parent_task_id: string | null;
      created_at: string;
      updated_at: string;
    }[];
    events: {
      event_id: string;
      event_type:
        | "task_created"
        | "task_injected"
        | "task_followup_created"
        | "task_status_changed"
        | "handoff_registered"
        | "checkpoint_created"
        | "checkpoint_restored"
        | "intervention_recorded";
      created_at: string;
      source: "user" | "agent" | "system";
      actor_id: string | null;
      task_id: string | null;
      checkpoint_id: string | null;
      handoff_id: string | null;
      payload: {
        [k: string]: unknown;
      };
    }[];
    handoffs: {
      handoff_id: string;
      handoff_kind:
        | "compute"
        | "feedback"
        | "literature"
        | "review"
        | "writing";
      workspace_id: string;
      source_task_id: string;
      target_node_id: string;
      source: "user" | "agent" | "system";
      actor_id: string | null;
      created_at: string;
      payload: {
        [k: string]: unknown;
      };
    }[];
    active_task_ids: string[];
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
