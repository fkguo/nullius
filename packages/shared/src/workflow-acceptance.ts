/** A workflow package selects its checks; the control plane only executes and
 * binds them. Paths are relative to the installed source runtime. */
export interface WorkflowAcceptanceCheckSpec {
  id: string;
  checker_path: string;
  checker_sources: string[];
  request: Record<string, unknown>;
}

export interface WorkflowAcceptanceInput {
  path: string;
  sha256: string;
}

/** Structured output of an actually executed checker, never a caller verdict. */
export interface WorkflowAcceptanceCheckerResult {
  schema_version: 1;
  check_id: string;
  run_id: string;
  workflow_id: string;
  plan_sha256: string;
  outputs_sha256: string;
  status: 'passed' | 'failed' | 'incomplete' | 'unavailable';
  summary: string;
  findings: string[];
  inputs: WorkflowAcceptanceInput[];
}
