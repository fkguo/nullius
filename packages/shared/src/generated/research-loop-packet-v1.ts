/* AUTO-GENERATED — DO NOT EDIT. Source: meta/schemas/ */
/**
 * This interface was referenced by `ResearchLoopPacketV1`'s JSON-Schema
 * via the `definition` "surface_ref".
 */
export type SurfaceRef =
  | {
      ref_kind: "workspace_node";
      node_id: string;
    }
  | {
      ref_kind: "workspace_edge";
      edge_id: string;
    }
  | {
      ref_kind: "task";
      task_kind: TaskKind;
      target_node_id?: string;
    }
  | {
      ref_kind: "handoff";
      handoff_kind: HandoffKind;
      target_node_id?: string;
    }
  | {
      ref_kind: "artifact";
      artifact_ref: ArtifactRefV1;
    };
/**
 * This interface was referenced by `ResearchLoopPacketV1`'s JSON-Schema
 * via the `definition` "task_kind".
 */
export type TaskKind =
  | "literature"
  | "idea"
  | "compute"
  | "evidence_search"
  | "finding"
  | "draft_update"
  | "review";
/**
 * This interface was referenced by `ResearchLoopPacketV1`'s JSON-Schema
 * via the `definition` "handoff_kind".
 */
export type HandoffKind =
  | "compute"
  | "feedback"
  | "literature"
  | "review"
  | "writing";
/**
 * This interface was referenced by `ResearchLoopPacketV1`'s JSON-Schema
 * via the `definition` "gate_condition".
 */
export type GateCondition =
  | {
      condition_kind: "task_status";
      task_kind: TaskKind;
      /**
       * @minItems 1
       */
      allowed_statuses: [TaskStatus, ...TaskStatus[]];
      target_node_id?: string;
    }
  | {
      condition_kind: "handoff_registered";
      handoff_kind: HandoffKind;
      target_node_id?: string;
    }
  | {
      condition_kind: "artifact_available";
      artifact_ref: ArtifactRefV11;
    }
  | {
      condition_kind: "checkpoint_available";
      checkpoint_label?: string | null;
    };
/**
 * This interface was referenced by `ResearchLoopPacketV1`'s JSON-Schema
 * via the `definition` "task_status".
 */
export type TaskStatus =
  | "pending"
  | "active"
  | "completed"
  | "blocked"
  | "cancelled";
/**
 * This interface was referenced by `ResearchLoopPacketV1`'s JSON-Schema
 * via the `definition` "stop_condition".
 */
export type StopCondition =
  | {
      condition_kind: "no_active_tasks";
    }
  | {
      condition_kind: "task_terminal";
      task_kind: TaskKind;
      /**
       * @minItems 1
       */
      terminal_statuses: [TaskStatus, ...TaskStatus[]];
    }
  | {
      condition_kind: "checkpoint_restored";
      checkpoint_label?: string | null;
    }
  | {
      condition_kind: "intervention";
      intervention_kind: InterventionKind;
    }
  | {
      condition_kind: "decision_node";
      node_id: string;
    };
/**
 * This interface was referenced by `ResearchLoopPacketV1`'s JSON-Schema
 * via the `definition` "intervention_kind".
 */
export type InterventionKind =
  | "pause"
  | "resume"
  | "redirect"
  | "inject_task"
  | "approve"
  | "cancel"
  | "cascade_stop";

/**
 * Single-project contract that makes research-loop objective, mutable surfaces, immutable authority references, gate seams, advancement, rollback, and stop semantics explicit without replacing the underlying workspace/task/event/checkpoint/handoff substrate.
 */
export interface ResearchLoopPacketV1 {
  schema_version: 1;
  scope: "single_project";
  packet_id: string;
  workspace_id: string;
  objective: string;
  /**
   * @minItems 1
   */
  mutable_surfaces: [SurfaceRef, ...SurfaceRef[]];
  /**
   * @minItems 1
   */
  immutable_authority_refs: [SurfaceRef, ...SurfaceRef[]];
  /**
   * @minItems 1
   */
  gate_conditions: [GateCondition, ...GateCondition[]];
  advancement: {
    /**
     * @minItems 1
     */
    allowed_followups: [TaskTransition, ...TaskTransition[]];
  };
  rollback: {
    /**
     * @minItems 1
     */
    allowed_backtracks: [TaskTransition, ...TaskTransition[]];
  };
  /**
   * @minItems 1
   */
  stop_conditions: [StopCondition, ...StopCondition[]];
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
 * This interface was referenced by `ResearchLoopPacketV1`'s JSON-Schema
 * via the `definition` "task_transition".
 */
export interface TaskTransition {
  from_task_kind: TaskKind;
  to_task_kind: TaskKind;
}
