import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { StateManager } from '../state-manager.js';
import { utcNowIso } from '../util.js';
import { ensureDir, toPosixRelative, writeJsonAtomic } from './io.js';
import type {
  CompletedExecutionResult,
  ExecutionStatusFile,
  FailedExecutionResult,
  PreparedManifest,
  StepCommandPlan,
} from './types.js';

function buildStatus(prepared: PreparedManifest): ExecutionStatusFile {
  return {
    schema_version: 1,
    run_id: prepared.runId,
    manifest_path: prepared.manifestRelativePath,
    manifest_sha256: prepared.manifestSha256,
    status: 'running',
    started_at: utcNowIso(),
    completed_at: null,
    errors: [],
    steps: prepared.steps.map(step => ({
      id: step.id,
      tool: step.tool,
      command: step.argv,
      script: step.scriptRelativePath,
      expected_outputs: step.expectedOutputs,
      status: 'pending',
      exit_code: null,
      started_at: null,
      completed_at: null,
      log_dir: '',
    })),
  };
}

function writeStepLogs(logDir: string, step: StepCommandPlan, output: ReturnType<typeof spawnSync>): void {
  ensureDir(logDir);
  fs.writeFileSync(path.join(logDir, 'stdout.txt'), output.stdout ?? '', 'utf-8');
  fs.writeFileSync(path.join(logDir, 'stderr.txt'), output.stderr ?? '', 'utf-8');
  writeJsonAtomic(path.join(logDir, 'meta.json'), {
    command: step.argv,
    exit_code: output.status,
    signal: output.signal,
    error: output.error?.message ?? null,
  });
}

export function runPreparedManifest(
  projectRoot: string,
  prepared: PreparedManifest,
): CompletedExecutionResult | FailedExecutionResult {
  const stateManager = new StateManager(projectRoot);
  const logsDir = path.join(prepared.workspaceDir, 'logs');
  const statusPath = path.join(prepared.workspaceDir, 'execution_status.json');
  const status = buildStatus(prepared);
  writeJsonAtomic(statusPath, status);
  for (const stepId of prepared.stepOrder) {
    const step = prepared.steps.find(candidate => candidate.id === stepId)!;
    const statusStep = status.steps.find(candidate => candidate.id === stepId)!;
    const logDir = path.join(logsDir, stepId);
    statusStep.status = 'running';
    statusStep.started_at = utcNowIso();
    statusStep.log_dir = toPosixRelative(prepared.workspaceDir, logDir);
    writeJsonAtomic(statusPath, status);
    const output = spawnSync(step.argv[0]!, step.argv.slice(1), {
      cwd: prepared.workspaceDir,
      encoding: 'utf-8',
      timeout: step.timeoutMinutes ? step.timeoutMinutes * 60_000 : undefined,
    });
    writeStepLogs(logDir, step, output);
    statusStep.exit_code = output.status ?? null;
    statusStep.completed_at = utcNowIso();
    if (output.error || output.status !== 0 || step.expectedOutputPaths.some(filePath => !fs.existsSync(filePath))) {
      statusStep.status = 'failed';
      status.status = 'failed';
      status.completed_at = utcNowIso();
      status.errors.push(output.error?.message ?? `step '${step.id}' failed`);
      writeJsonAtomic(statusPath, status);
      const failedState = stateManager.readState();
      if (failedState.run_status === 'running') {
        stateManager.transitionStatus(failedState, 'failed', {
          eventType: 'execution_failed',
          details: { run_id: prepared.runId, step_id: step.id, execution_status: statusPath },
        });
      }
      return {
        status: 'failed',
        ok: false,
        run_id: prepared.runId,
        manifest_path: prepared.manifestRelativePath,
        manifest_sha256: prepared.manifestSha256,
        artifact_paths: { execution_status: statusPath, logs_dir: logsDir },
        errors: [...status.errors],
      };
    }
    statusStep.status = 'completed';
    writeJsonAtomic(statusPath, status);
  }
  status.status = 'completed';
  status.completed_at = utcNowIso();
  writeJsonAtomic(statusPath, status);
  const completedState = stateManager.readState();
  if (completedState.run_status === 'running') {
    stateManager.transitionStatus(completedState, 'completed', {
      eventType: 'execution_completed',
      details: { run_id: prepared.runId, execution_status: statusPath },
    });
  }
  return {
    status: 'completed',
    ok: true,
    run_id: prepared.runId,
    manifest_path: prepared.manifestRelativePath,
    manifest_sha256: prepared.manifestSha256,
    artifact_paths: { execution_status: statusPath, logs_dir: logsDir },
    produced_outputs: prepared.steps.flatMap(step => step.expectedOutputPaths.filter(filePath => fs.existsSync(filePath))),
  };
}
