/* AUTO-GENERATED — DO NOT EDIT. Source: meta/schemas/ */
/**
 * This interface was referenced by `ResearchWorkflowV1`'s JSON-Schema
 * via the `definition` "WorkflowNode".
 */
export type WorkflowNode = {
  id: string;
  type: "tool_call" | "gate" | "human_review" | "parallel_group";
  /**
   * Human-readable label for display.
   */
  label?: string;
  /**
   * MCP tool name (required when type=tool_call).
   */
  tool_name?: string;
  /**
   * Static or template args passed to the tool.
   */
  tool_args?: {
    [k: string]: unknown;
  };
  gate_spec?: WorkflowGateSpec;
  /**
   * Child node IDs for parallel_group nodes.
   *
   * @minItems 1
   */
  children?: [string, ...string[]];
};
/**
 * This interface was referenced by `ResearchWorkflowV1`'s JSON-Schema
 * via the `definition` "WorkflowGateSpec".
 */
export type WorkflowGateSpec = {
  /**
   * approval = human approval required; quality_threshold = passes if metric >= threshold; automatic = always passes.
   */
  gate_type: "approval" | "quality_threshold" | "automatic";
  /**
   * Metric name for quality_threshold gates.
   */
  metric?: string;
  /**
   * Minimum value for quality_threshold gates.
   */
  threshold?: number;
};

/**
 * Declarative research workflow graph with nodes, edges, gates, and entry points.
 */
export interface ResearchWorkflowV1 {
  workflow_id: string;
  template: "review" | "original_research" | "reproduction";
  entry_point: EntryPoint;
  /**
   * @minItems 1
   */
  nodes: [WorkflowNode, ...WorkflowNode[]];
  edges: WorkflowEdge[];
  state_model?: StateModel;
}
/**
 * This interface was referenced by `ResearchWorkflowV1`'s JSON-Schema
 * via the `definition` "EntryPoint".
 */
export interface EntryPoint {
  variant:
    | "from_literature"
    | "from_idea"
    | "from_computation"
    | "from_existing_paper";
  /**
   * Variant-specific parameters (e.g. handoff_uri for from_idea, paper_id for from_existing_paper).
   */
  params?: {
    [k: string]: unknown;
  };
}
/**
 * This interface was referenced by `ResearchWorkflowV1`'s JSON-Schema
 * via the `definition` "WorkflowEdge".
 */
export interface WorkflowEdge {
  /**
   * Source node ID.
   */
  from: string;
  /**
   * Target node ID.
   */
  to: string;
  /**
   * Condition for traversal (e.g. 'approved', 'rejected', gate outcome).
   */
  condition?: string;
}
/**
 * This interface was referenced by `ResearchWorkflowV1`'s JSON-Schema
 * via the `definition` "StateModel".
 */
export interface StateModel {
  /**
   * Currently active node ID, or null if not started / completed.
   */
  current_node?: string | null;
  completed_nodes?: string[];
  gate_outcomes?: {
    [k: string]: "approved" | "rejected" | "pending";
  };
}
