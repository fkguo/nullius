import * as fs from 'node:fs';
import * as path from 'node:path';
import { executeComputationManifest } from './computation/index.js';
import type { CliIo } from './cli-lifecycle.js';
import { resolveLifecycleProjectRoot } from './cli-project-root.js';
import { resolveUserPath } from './project-policy.js';
import { StateManager } from './state-manager.js';
import type { RunState } from './types.js';

export type RunCommandInput = {
  command: 'run';
  projectRoot: string | null;
  workflowId: string | null;
  runId: string | null;
  runDir: string | null;
  manifestPath: string | null;
  dryRun: boolean;
};

type ResolvedRunInput = {
  projectRoot: string;
  workflowId: 'computation';
  runId: string;
  runDir: string;
  manifestPath: string;
  dryRun: boolean;
};

function isWithinPath(basePath: string, candidatePath: string): boolean {
  const relative = path.relative(path.resolve(basePath), path.resolve(candidatePath));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function normalizeRunId(raw: string | null): string {
  const runId = (raw ?? '').trim();
  if (!runId) {
    throw new Error('run requires --run-id <id> (or an existing state.run_id)');
  }
  if (runId.includes('/') || runId.includes('\\') || runId.includes('..')) {
    throw new Error(`run_id must be a simple identifier, got: ${runId}`);
  }
  return runId;
}

function resolveRunInput(input: RunCommandInput, io: CliIo): ResolvedRunInput {
  const projectRoot = resolveLifecycleProjectRoot(input.projectRoot, io.cwd);
  const manager = new StateManager(projectRoot);
  if (!fs.existsSync(manager.statePath)) {
    throw new Error(`project root is not initialized: ${projectRoot}; run autoresearch init first`);
  }
  const workflowIdRaw = (input.workflowId ?? 'computation').trim();
  if (workflowIdRaw !== 'computation') {
    throw new Error(`run currently supports only --workflow-id computation (got: ${workflowIdRaw || '(empty)'})`);
  }
  const state = manager.readState();
  const runId = normalizeRunId(input.runId ?? state.run_id);
  const runDir = input.runDir ? resolveUserPath(input.runDir, io.cwd) : path.join(projectRoot, runId);
  if (!isWithinPath(projectRoot, runDir)) {
    throw new Error(`run dir must stay within project root: ${runDir}`);
  }
  const manifestPath = input.manifestPath
    ? resolveUserPath(input.manifestPath, io.cwd)
    : path.join(runDir, 'computation', 'manifest.json');
  return {
    projectRoot,
    workflowId: 'computation',
    runId,
    runDir,
    manifestPath,
    dryRun: input.dryRun,
  };
}

function resetForFreshComputationRun(state: RunState): void {
  state.run_status = 'idle';
  state.run_id = null;
  state.workflow_id = null;
  state.current_step = null;
  state.plan = null;
  state.plan_md_path = null;
  state.pending_approval = null;
  state.gate_satisfied = {};
  state.approval_history = [];
  state.artifacts = {};
  state.notes = '';
  state.checkpoints.last_checkpoint_at = null;
  delete state.paused_from_status;
}

function ensureComputationRunStarted(manager: StateManager, runId: string): void {
  const state = manager.readState();
  if (state.run_status === 'running') {
    if (state.run_id !== runId || state.workflow_id !== 'computation') {
      throw new Error(
        `cannot start computation run_id=${runId} while another run is active (${state.run_id ?? 'unknown'}:${state.workflow_id ?? 'unknown'})`,
      );
    }
    return;
  }
  if (state.run_status === 'awaiting_approval') {
    if (state.run_id === runId && state.workflow_id === 'computation') {
      return;
    }
    throw new Error('cannot run while status is awaiting_approval; approve or reject the pending gate first');
  }
  if (state.run_status === 'paused' || state.run_status === 'blocked' || state.run_status === 'needs_recovery') {
    throw new Error(`cannot run while status is ${state.run_status}; resume or recover the current run first`);
  }
  resetForFreshComputationRun(state);
  manager.createRun(state, runId, 'computation');
}

export async function runComputationCommand(input: RunCommandInput, io: CliIo): Promise<number> {
  const resolved = resolveRunInput(input, io);
  const manager = new StateManager(resolved.projectRoot);
  if (!resolved.dryRun) {
    ensureComputationRunStarted(manager, resolved.runId);
  }

  const result = await executeComputationManifest({
    runId: resolved.runId,
    runDir: resolved.runDir,
    projectRoot: resolved.projectRoot,
    manifestPath: resolved.manifestPath,
    dryRun: resolved.dryRun,
  });
  io.stdout(`${JSON.stringify(result, null, 2)}\n`);
  return result.status === 'failed' ? 1 : 0;
}
