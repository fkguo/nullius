import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { StateManager } from '../state-manager.js';
import { maybeQueueIdeaEngineComputationFeedback } from './idea-engine-feedback.js';
import { utcNowIso } from '../util.js';
import { ensureDir, toPosixRelative, writeJsonAtomic } from './io.js';
import { recordComputationResultToMemoryGraph } from './memory-graph-hookup.js';
import { writeComputationResultArtifact } from './result.js';
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

export async function runPreparedManifest(
  projectRoot: string,
  prepared: PreparedManifest,
): Promise<CompletedExecutionResult | FailedExecutionResult> {
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
    const missingOutputs = step.expectedOutputPaths.filter(filePath => !fs.existsSync(filePath));
    if (output.error || output.status !== 0 || missingOutputs.length > 0) {
      statusStep.status = 'failed';
      status.status = 'failed';
      status.completed_at = utcNowIso();
      const failureReason = output.error?.message
        ?? (output.status !== 0
          ? `step '${step.id}' exited with code ${output.status}`
          : `step '${step.id}' did not produce expected outputs: ${missingOutputs.map(filePath => toPosixRelative(prepared.runDir, filePath)).join(', ')}`);
      status.errors.push(failureReason);
      writeJsonAtomic(statusPath, status);
      const failedState = stateManager.readState();
      if (failedState.run_status === 'running') {
        stateManager.transitionStatus(failedState, 'failed', {
          eventType: 'execution_failed',
          details: { run_id: prepared.runId, step_id: step.id, execution_status: statusPath },
        });
      }
      const { computationResult, computationResultPath, computationResultRef } = writeComputationResultArtifact({
        prepared,
        status,
        statusPath,
        logsDir,
        producedOutputs: prepared.steps.flatMap(currentStep => currentStep.expectedOutputPaths.filter(filePath => fs.existsSync(filePath))),
        failureReason,
      });
      maybeQueueIdeaEngineComputationFeedback({
        prepared,
        computationResult,
      });
      const memoryGraph = await recordComputationResultToMemoryGraph({
        projectRoot,
        manifest: prepared.manifest,
        computationResult,
      });
      if (memoryGraph.repairProposalPath) {
        const state = stateManager.readState();
        state.artifacts = {
          ...state.artifacts,
          mutation_proposal_repair_v1: toPosixRelative(projectRoot, memoryGraph.repairProposalPath),
        };
        stateManager.saveState(state);
        stateManager.appendLedger('repair_mutation_proposed', {
          run_id: prepared.runId,
          workflow_id: 'computation',
          details: {
            proposal_id: memoryGraph.repairProposalId,
            proposal_path: toPosixRelative(projectRoot, memoryGraph.repairProposalPath),
          },
        });
      }
      return {
        status: 'failed',
        ok: false,
        run_id: prepared.runId,
        manifest_path: prepared.manifestRelativePath,
        manifest_sha256: prepared.manifestSha256,
        artifact_paths: {
          execution_status: statusPath,
          logs_dir: logsDir,
          computation_result: computationResultPath,
        },
        outcome_ref: computationResultRef,
        next_actions: computationResult.next_actions,
        followup_bridge_refs: computationResult.followup_bridge_refs,
        summary: computationResult.summary,
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
  const producedOutputs = prepared.steps.flatMap(step => step.expectedOutputPaths.filter(filePath => fs.existsSync(filePath)));
  const { computationResult, computationResultPath, computationResultRef } = writeComputationResultArtifact({
    prepared,
    status,
    statusPath,
    logsDir,
    producedOutputs,
  });
  maybeQueueIdeaEngineComputationFeedback({
    prepared,
    computationResult,
  });
  const memoryGraph = await recordComputationResultToMemoryGraph({
    projectRoot,
    manifest: prepared.manifest,
    computationResult,
  });
  if (memoryGraph.repairProposalPath) {
    const state = stateManager.readState();
    state.artifacts = {
      ...state.artifacts,
      mutation_proposal_repair_v1: toPosixRelative(projectRoot, memoryGraph.repairProposalPath),
    };
    stateManager.saveState(state);
    stateManager.appendLedger('repair_mutation_proposed', {
      run_id: prepared.runId,
      workflow_id: 'computation',
      details: {
        proposal_id: memoryGraph.repairProposalId,
        proposal_path: toPosixRelative(projectRoot, memoryGraph.repairProposalPath),
      },
    });
  }
  return {
    status: 'completed',
    ok: true,
    run_id: prepared.runId,
    manifest_path: prepared.manifestRelativePath,
    manifest_sha256: prepared.manifestSha256,
    artifact_paths: {
      execution_status: statusPath,
      logs_dir: logsDir,
      computation_result: computationResultPath,
    },
    outcome_ref: computationResultRef,
    next_actions: computationResult.next_actions,
    followup_bridge_refs: computationResult.followup_bridge_refs,
    summary: computationResult.summary,
    produced_outputs: producedOutputs,
  };
}
