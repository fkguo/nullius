/* AUTO-GENERATED — DO NOT EDIT. Source: meta/schemas/ */
/**
 * This interface was referenced by `DelegationBudgetGateResultV1`'s JSON-Schema
 * via the `definition` "DelegationBudgetGateStatus".
 */
export type DelegationBudgetGateStatus = "pass" | "fail" | "input_error";
/**
 * This interface was referenced by `DelegationBudgetGateResultV1`'s JSON-Schema
 * via the `definition` "DelegationBudgetGateExitCode".
 */
export type DelegationBudgetGateExitCode = 0 | 1 | 2;
/**
 * This interface was referenced by `DelegationBudgetGateResultV1`'s JSON-Schema
 * via the `definition` "DelegationBudgetContractVerdict".
 */
export type DelegationBudgetContractVerdict =
  | "ready"
  | "needs_revision"
  | "unknown";

/**
 * Structured machine-readable output contract for the domain-neutral delegation budget pre-dispatch gate.
 */
export interface DelegationBudgetGateResultV1 {
  status: DelegationBudgetGateStatus;
  exit_code: DelegationBudgetGateExitCode;
  reasons: string[];
  contract_status: {
    [k: string]: DelegationBudgetContractStatus;
  };
  meta: DelegationBudgetGateMeta;
}
/**
 * This interface was referenced by `undefined`'s JSON-Schema definition
 * via the `patternProperty` "^[a-z][a-z0-9_]*$".
 *
 * This interface was referenced by `DelegationBudgetGateResultV1`'s JSON-Schema
 * via the `definition` "DelegationBudgetContractStatus".
 */
export interface DelegationBudgetContractStatus {
  verdict: DelegationBudgetContractVerdict;
  blocking_count: number;
  parse_ok: boolean;
  source_path?: string;
  errors?: string[];
}
/**
 * This interface was referenced by `DelegationBudgetGateResultV1`'s JSON-Schema
 * via the `definition` "DelegationBudgetGateMeta".
 */
export interface DelegationBudgetGateMeta {
  gate_id: "delegation_budget";
  generated_at: string;
  parser_version: string;
  schema_id: "delegation_budget_gate_result_v1";
  schema_version: 1;
  tag?: string;
}
