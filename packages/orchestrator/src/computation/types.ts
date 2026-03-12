import type { ComputationManifestV1 } from '@autoresearch/shared';

export type ManifestTool = 'mathematica' | 'julia' | 'python' | 'bash';
export type ExecutionStatus = 'dry_run' | 'requires_approval' | 'completed' | 'failed';
export type StepStatus = 'pending' | 'running' | 'completed' | 'failed';

export interface ExecuteComputationManifestInput {
  runId: string;
  runDir: string;
  projectRoot: string;
  manifestPath: string;
  dryRun?: boolean;
}

export interface StepCommandPlan {
  id: string;
  tool: ManifestTool;
  argv: string[];
  scriptPath: string;
  scriptRelativePath: string;
  expectedOutputs: string[];
  expectedOutputPaths: string[];
  timeoutMinutes: number | null;
}

export interface PreparedManifest {
  manifest: ComputationManifestV1;
  manifestPath: string;
  manifestRelativePath: string;
  manifestSha256: string;
  runId: string;
  runDir: string;
  workspaceDir: string;
  stepOrder: string[];
  steps: StepCommandPlan[];
  topLevelOutputs: string[];
}

export interface ExecutionArtifactPaths {
  execution_status: string;
  logs_dir: string;
}

export interface DryRunExecutionResult {
  status: 'dry_run';
  validated: true;
  dry_run: true;
  manifest_path: string;
  manifest_sha256: string;
  workspace_dir: string;
  step_order: string[];
  steps: Array<{
    id: string;
    tool: ManifestTool;
    script: string;
    command: string[];
    expected_outputs: string[];
  }>;
}

export interface ApprovalRequiredExecutionResult {
  status: 'requires_approval';
  requires_approval: true;
  gate_id: 'A3';
  run_id: string;
  approval_id: string;
  approval_packet_sha256: string;
  packet_path: string;
  packet_json_path: string;
  message: string;
}

export interface CompletedExecutionResult {
  status: 'completed';
  ok: true;
  run_id: string;
  manifest_path: string;
  manifest_sha256: string;
  artifact_paths: ExecutionArtifactPaths;
  produced_outputs: string[];
}

export interface FailedExecutionResult {
  status: 'failed';
  ok: false;
  run_id: string;
  manifest_path: string;
  manifest_sha256: string;
  artifact_paths: ExecutionArtifactPaths;
  errors: string[];
}

export type ExecuteComputationManifestResult =
  | DryRunExecutionResult
  | ApprovalRequiredExecutionResult
  | CompletedExecutionResult
  | FailedExecutionResult;

export interface ExecutionStatusFile {
  schema_version: 1;
  run_id: string;
  manifest_path: string;
  manifest_sha256: string;
  status: 'running' | 'completed' | 'failed';
  started_at: string;
  completed_at: string | null;
  errors: string[];
  steps: Array<{
    id: string;
    tool: ManifestTool;
    command: string[];
    script: string;
    expected_outputs: string[];
    status: StepStatus;
    exit_code: number | null;
    started_at: string | null;
    completed_at: string | null;
    log_dir: string;
  }>;
}
