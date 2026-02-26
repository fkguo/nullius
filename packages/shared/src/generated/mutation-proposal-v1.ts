/* AUTO-GENERATED — DO NOT EDIT. Source: meta/schemas/ */
/**
 * Evolution mutation proposal — repair, optimize, or innovate. Produced by EVO-21 proactive evolution engine.
 */
export interface MutationProposalV1 {
  /**
   * Unique proposal identifier (ID-01 compliant)
   */
  proposal_id: string;
  /**
   * Mutation type determining validation requirements and risk level
   */
  mutation_type: "repair" | "optimize" | "innovate";
  /**
   * Selected gene to execute
   */
  gene_id: string;
  /**
   * Signals that triggered this mutation
   */
  signals: string[];
  strategy: StrategyState;
  /**
   * Strategy mutations applied for this run
   */
  strategy_mutations?: StrategyMutation[];
  /**
   * Required approval gate level
   */
  gate_level: "A0" | "A1" | "A2" | "reject";
  /**
   * Blast radius severity (populated after execution)
   */
  blast_severity?:
    | "within_limit"
    | "approaching_limit"
    | "exceeded"
    | "critical_overrun"
    | "hard_cap_breach"
    | null;
  /**
   * Current proposal status
   */
  status:
    | "proposed"
    | "approved"
    | "executing"
    | "succeeded"
    | "failed"
    | "rejected"
    | "rolled_back";
  result?: MutationResult;
  run_id?: string | null;
  created_at: string;
  completed_at?: string | null;
}
/**
 * This interface was referenced by `MutationProposalV1`'s JSON-Schema
 * via the `definition` "StrategyState".
 */
export interface StrategyState {
  /**
   * Validation thoroughness (0=minimal, 1=exhaustive)
   */
  rigor: number;
  /**
   * Willingness to try novel approaches
   */
  creativity: number;
  /**
   * Output detail level
   */
  verbosity: number;
  /**
   * Acceptable blast radius tolerance
   */
  risk_tolerance: number;
  /**
   * Constraint adherence level
   */
  obedience: number;
}
/**
 * This interface was referenced by `MutationProposalV1`'s JSON-Schema
 * via the `definition` "StrategyMutation".
 */
export interface StrategyMutation {
  param: "rigor" | "creativity" | "verbosity" | "risk_tolerance" | "obedience";
  /**
   * Change amount (clamped to ±0.2)
   */
  delta: number;
  /**
   * Why this mutation was proposed
   */
  reason: string;
}
/**
 * This interface was referenced by `MutationProposalV1`'s JSON-Schema
 * via the `definition` "MutationResult".
 */
export interface MutationResult {
  success?: boolean;
  /**
   * Failure reason if !success
   */
  reason?: string;
  /**
   * Created capsule ID on success
   */
  capsule_id?: string | null;
  quality_score?: number;
  blast_radius?: {
    files_changed?: number;
    lines_added?: number;
    lines_removed?: number;
    [k: string]: unknown;
  };
  validation_passed?: boolean;
  contract_passed?: boolean;
}
