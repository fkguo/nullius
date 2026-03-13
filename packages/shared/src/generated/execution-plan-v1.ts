/* AUTO-GENERATED — DO NOT EDIT. Source: meta/schemas/ */
/**
 * Provider-neutral audited IR for bridging staged idea surfaces into a materialized computation manifest. Captures provenance, task-level capability needs, and expected artifacts without fixing provider routing as long-term authority.
 */
export interface ExecutionPlanV1 {
  /**
   * Schema version, always 1 for this schema.
   */
  schema_version: 1;
  /**
   * Run identifier this execution plan belongs to.
   */
  run_id: string;
  /**
   * Human-readable objective derived from the staged thesis.
   */
  objective: string;
  source: {
    /**
     * Canonical run-local path to outline_seed_v1.json.
     */
    outline_seed_path: string;
    /**
     * Original source handoff URI preserved from the staged idea surface.
     */
    source_handoff_uri: string;
    /**
     * Optional campaign provenance copied from IdeaHandoffC2 when available.
     */
    campaign_id?: string;
    /**
     * Optional node provenance copied from IdeaHandoffC2 when available.
     */
    node_id?: string;
    /**
     * Optional idea provenance copied from IdeaHandoffC2 when available.
     */
    idea_id?: string;
    /**
     * Optional promotion timestamp copied from IdeaHandoffC2 when available.
     */
    promoted_at?: string;
    /**
     * Optional observable-level hints copied from the staged handoff.
     */
    required_observables?: string[];
    /**
     * Optional non-authoritative method/formalism hints preserved for local context.
     */
    candidate_formalisms?: string[];
    /**
     * Whether an upstream method_spec-like payload was present on the staged handoff surface.
     */
    method_spec_present?: boolean;
    /**
     * Number of structured method hints consumed by the compiler.
     */
    method_hint_count?: number;
  };
  /**
   * @minItems 1
   */
  tasks: [
    {
      task_id: string;
      title: string;
      description?: string;
      /**
       * Indices into outline_seed_v1.hypotheses that motivate this task.
       */
      hypothesis_indices: number[];
      /**
       * Indices into outline_seed_v1.claims that inform this task.
       */
      claim_indices: number[];
      /**
       * Indices into staged method hints consumed by this task.
       */
      method_hint_indices: number[];
      observables?: string[];
      /**
       * Non-authoritative summary of the method hint that informed this task.
       */
      method_hint_summary?: string;
      /**
       * Provider-neutral capability requirements for this task.
       *
       * @minItems 1
       */
      capabilities: [string, ...string[]];
      /**
       * Optional future-facing DAG dependencies.
       */
      depends_on_task_ids?: string[];
      /**
       * @minItems 1
       */
      expected_artifacts: [
        {
          artifact_id: string;
          kind: string;
          path: string;
          description?: string;
        },
        ...{
          artifact_id: string;
          kind: string;
          path: string;
          description?: string;
        }[],
      ];
      /**
       * Optional generic hints reserved for the manifest materializer.
       */
      lowering_hints?: {
        workspace_subdir?: string;
      };
    },
    ...{
      task_id: string;
      title: string;
      description?: string;
      /**
       * Indices into outline_seed_v1.hypotheses that motivate this task.
       */
      hypothesis_indices: number[];
      /**
       * Indices into outline_seed_v1.claims that inform this task.
       */
      claim_indices: number[];
      /**
       * Indices into staged method hints consumed by this task.
       */
      method_hint_indices: number[];
      observables?: string[];
      /**
       * Non-authoritative summary of the method hint that informed this task.
       */
      method_hint_summary?: string;
      /**
       * Provider-neutral capability requirements for this task.
       *
       * @minItems 1
       */
      capabilities: [string, ...string[]];
      /**
       * Optional future-facing DAG dependencies.
       */
      depends_on_task_ids?: string[];
      /**
       * @minItems 1
       */
      expected_artifacts: [
        {
          artifact_id: string;
          kind: string;
          path: string;
          description?: string;
        },
        ...{
          artifact_id: string;
          kind: string;
          path: string;
          description?: string;
        }[],
      ];
      /**
       * Optional generic hints reserved for the manifest materializer.
       */
      lowering_hints?: {
        workspace_subdir?: string;
      };
    }[],
  ];
  /**
   * ISO 8601 UTC timestamp when this plan was compiled.
   */
  created_at?: string;
}
