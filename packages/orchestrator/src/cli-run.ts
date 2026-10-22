import * as fs from 'node:fs';
import * as path from 'node:path';
import { executeComputationManifest } from './computation/index.js';
import { writeJsonAtomic } from './computation/io.js';
import type { CliIo } from './cli-lifecycle.js';
import { resolveLifecycleProjectRoot } from './cli-project-root.js';
import { resolveUserPath } from './project-policy.js';
import { resolveProjectContainedPath } from './computation/path-safety.js';
import { assertWritableRunId, assertExecutionRunDirectory, runDirFor } from './run-paths.js';
import { createToolAttemptIdentity, RunManifestManager } from './run-manifest.js';
import { StateManager } from './state-manager.js';
import { parseRunGateApprovalRequest, type RunGateApprovalRequest } from './tool-approval-envelope.js';
import { resolveToolExecutionPolicy } from './tool-execution-policy.js';
import type { RunState, WorkflowOutputView } from './types.js';
import { utcNowIso } from './util.js';
import { evaluateWorkflowAcceptance, workflowAcceptanceExitCode, type WorkflowAcceptanceDeps } from './workflow-acceptance.js';
import {
  compileWorkflowRuntimeRequest,
  executeWorkflowRuntimeRequest,
  normalizeWorkflowRuntimeResult,
  parsePersistedWorkflowExecution,
  type PersistedWorkflowPlanStep,
  type WorkflowRuntimeDeps,
} from './workflow-runtime.js';

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
  kind: 'computation';
  projectRoot: string;
  workflowId: 'computation';
  runId: string;
  runDir: string;
  manifestPath: string;
  dryRun: boolean;
};

type WorkflowResolvedRunInput = {
  kind: 'workflow';
  projectRoot: string;
  workflowId: string;
  runId: string;
  dryRun: boolean;
};

type AnyResolvedRunInput = ResolvedRunInput | WorkflowResolvedRunInput;

export type RunCommandDeps = {
  workflowAcceptance?: WorkflowAcceptanceDeps;
  workflowToolCaller?: WorkflowRuntimeDeps['workflowToolCaller'];
};

function classifyWorkflowCompileDiagnostic(message: string): 'malformed_execution' | 'project_required_missing' | 'run_required_missing' {
  if (/requires project_root\b/.test(message)) return 'project_required_missing';
  if (/requires run_id\b/.test(message)) return 'run_required_missing';
  return 'malformed_execution';
}

function buildWorkflowOutputView(params: {
  stepId: string;
  tool: string;
  runtimeStatus: 'completed' | 'partial' | 'skipped' | 'failed';
  artifactUri: string | null;
  additionalArtifactUris: string[];
  summaryText: string;
  reasonCode: string | null;
  recoverable: boolean;
  payload: unknown;
}): WorkflowOutputView {
  let payload: unknown | null = params.payload ?? null;
  let payloadTruncated = false;
  if (payload !== null) {
    try {
      const serialized = JSON.stringify(payload);
      if (serialized.length > 40000) {
        payload = null;
        payloadTruncated = true;
      }
    } catch {
      payload = null;
      payloadTruncated = true;
    }
  }
  return {
    step_id: params.stepId,
    tool: params.tool,
    runtime_status: params.runtimeStatus,
    artifact_uri: params.artifactUri,
    additional_artifact_uris: params.additionalArtifactUris,
    summary_text: params.summaryText.slice(0, 4000),
    reason_code: params.reasonCode,
    recoverable: params.recoverable,
    payload,
    payload_truncated: payloadTruncated,
  };
}

function artifactKeyForWorkflowStep(step: PersistedWorkflowPlanStep): string {
  const artifactHint = typeof step.execution?.consumer_hints?.artifact === 'string'
    ? step.execution.consumer_hints.artifact.trim()
    : '';
  return artifactHint || step.step_id;
}

function deriveWorkflowOutputRecoveryMetadata(params: {
  runtimeStatus: 'completed' | 'partial' | 'skipped' | 'failed';
  payload: unknown;
  summaryText: string;
  diagnostics?: Array<{ code?: string; details?: Record<string, unknown> | undefined }>;
}): { reasonCode: string | null; recoverable: boolean } {
  const candidates: Array<string | null> = [];
  for (const diagnostic of params.diagnostics ?? []) {
    const reason = typeof diagnostic.details?.reason === 'string' ? diagnostic.details.reason : null;
    candidates.push(reason);
  }
  if (params.payload && typeof params.payload === 'object' && !Array.isArray(params.payload)) {
    const payloadRecord = params.payload as Record<string, unknown>;
    candidates.push(typeof payloadRecord.reason === 'string' ? payloadRecord.reason : null);
  }
  if (params.summaryText.includes('no_input_recids')) {
    candidates.push('no_input_recids');
  }
  const reasonCode = candidates.find((candidate): candidate is string => Boolean(candidate && candidate.trim())) ?? null;
  return {
    reasonCode,
    recoverable: params.runtimeStatus === 'skipped' && reasonCode === 'no_input_recids',
  };
}

function workflowStepArtifactUri(runId: string, stepId: string): string {
  return `orch://runs/${runId}/artifact/workflow_steps/${stepId}.json`;
}

function materializeWorkflowStepPayloadArtifact(params: {
  projectRoot: string;
  state: RunState;
  step: PersistedWorkflowPlanStep;
  artifactKey: string;
  tool: string;
  runtimeStatus: 'completed' | 'partial' | 'skipped' | 'failed';
  summaryText: string;
  payload: unknown;
}): string | null {
  if ((params.runtimeStatus !== 'completed' && params.runtimeStatus !== 'partial') || params.payload === null || params.payload === undefined) {
    return null;
  }
  const runId = params.state.run_id;
  if (!runId) return null;
  const relativeArtifactPath = ['artifacts', 'runs', runId, 'workflow_steps', `${params.step.step_id}.json`];
  const artifactPath = path.join(params.projectRoot, ...relativeArtifactPath);
  writeJsonAtomic(artifactPath, {
    schema_version: 1,
    workflow_id: params.state.workflow_id,
    run_id: runId,
    step_id: params.step.step_id,
    artifact_key: params.artifactKey,
    status: params.runtimeStatus,
    tool: params.tool,
    summary: params.summaryText.slice(0, 4000),
    payload: params.payload,
  });
  return workflowStepArtifactUri(runId, params.step.step_id);
}

function projectWorkflowTerminalStep(params: {
  projectRoot: string;
  state: RunState;
  step: PersistedWorkflowPlanStep;
  tool: string;
  artifactKey: string;
  runtimeStatus: 'completed' | 'partial' | 'skipped' | 'failed';
  artifactUri: string | null;
  additionalArtifactUris: string[];
  summaryText: string;
  payload: unknown;
  diagnostics?: Array<{ code?: string; details?: Record<string, unknown> | undefined }>;
}): { reasonCode: string | null; recoverable: boolean } {
  const recovery = deriveWorkflowOutputRecoveryMetadata({
    runtimeStatus: params.runtimeStatus,
    payload: params.payload,
    summaryText: params.summaryText,
    diagnostics: params.diagnostics,
  });
  const artifactUri = params.artifactUri ?? materializeWorkflowStepPayloadArtifact({
    projectRoot: params.projectRoot,
    state: params.state,
    step: params.step,
    artifactKey: params.artifactKey,
    tool: params.tool,
    runtimeStatus: params.runtimeStatus,
    summaryText: params.summaryText,
    payload: params.payload,
  });
  if (artifactUri) {
    params.state.artifacts[params.artifactKey] = artifactUri;
  }
  params.state.workflow_outputs[params.artifactKey] = buildWorkflowOutputView({
    stepId: params.step.step_id,
    tool: params.tool,
    runtimeStatus: params.runtimeStatus,
    artifactUri,
    additionalArtifactUris: params.additionalArtifactUris,
    summaryText: params.summaryText,
    reasonCode: recovery.reasonCode,
    recoverable: recovery.recoverable,
    payload: params.payload,
  });
  params.state.notes = params.summaryText.slice(0, 2000);
  return recovery;
}

function normalizeRunId(raw: string | null): string {
  const runId = (raw ?? '').trim();
  if (!runId) {
    throw new Error('run requires --run-id <id> (or an existing state.run_id)');
  }
  if (!/^[A-Za-z0-9._-]+$/.test(runId) || runId === '.' || runId.includes('..')) {
    throw new Error(`run_id must be a simple identifier, got: ${runId}`);
  }
  return runId;
}

function resolveRunInput(input: RunCommandInput, io: CliIo): AnyResolvedRunInput {
  const projectRoot = resolveLifecycleProjectRoot(input.projectRoot, io.cwd);
  const manager = new StateManager(projectRoot);
  if (!fs.existsSync(manager.statePath)) {
    throw new Error(`project root is not initialized: ${projectRoot}; run nullius init first`);
  }
  const state = manager.readState();
  const workflowIdRaw = (input.workflowId ?? state.workflow_id ?? 'computation').trim();
  const runId = normalizeRunId(input.runId ?? state.run_id);
  if (workflowIdRaw !== 'computation') {
    if (input.runDir || input.manifestPath) {
      throw new Error('run --run-dir/--manifest are only supported for --workflow-id computation');
    }
    if (state.workflow_id && state.workflow_id !== workflowIdRaw) {
      throw new Error(
        `run workflow_id mismatch: state.workflow_id=${state.workflow_id} but got ${workflowIdRaw}`,
      );
    }
    return {
      kind: 'workflow',
      projectRoot,
      workflowId: workflowIdRaw,
      runId,
      dryRun: input.dryRun,
    };
  }
  // Default run dir lives under artifacts/runs/ — the canonical stampable
  // run root — so a front-door run is visible to the traceability read model
  // and receives its automatic launch stamp without any flag. runDirFor is
  // the ONE definition shared with every lifecycle reader (verification,
  // final-conclusions, team summary, proposal genesis).
  const runDir = input.runDir
    ? resolveProjectContainedPath(projectRoot, resolveUserPath(input.runDir, io.cwd), 'run dir')
    : runDirFor(projectRoot, runId);
  const manifestPath = input.manifestPath
    ? resolveProjectContainedPath(projectRoot, resolveUserPath(input.manifestPath, io.cwd), 'manifest path')
    : path.join(runDir, 'computation', 'manifest.json');
  return {
    kind: 'computation',
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

function getWorkflowPlanSteps(state: RunState): PersistedWorkflowPlanStep[] {
  const plan = state.plan;
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) {
    throw new Error('run requires state.plan to execute a persisted workflow plan');
  }
  const stepsRaw = (plan as Record<string, unknown>).steps;
  if (!Array.isArray(stepsRaw) || stepsRaw.length === 0) {
    throw new Error('run requires state.plan.steps to contain at least one persisted workflow step');
  }
  return stepsRaw.map((rawStep): PersistedWorkflowPlanStep => {
    const step = rawStep as Record<string, unknown>;
    return {
      step_id: String(step.step_id ?? ''),
      description: String(step.description ?? ''),
      status: String(step.status ?? 'pending'),
      execution: parsePersistedWorkflowExecution(step.execution),
    };
  });
}

function dependenciesSatisfied(step: PersistedWorkflowPlanStep, byId: Map<string, PersistedWorkflowPlanStep>): boolean {
  return step.execution?.depends_on.every(depId => {
    const dep = byId.get(depId);
    return dep?.status === 'completed' || dep?.status === 'skipped';
  }) ?? true;
}

function selectNextWorkflowStep(state: RunState): {
  step: PersistedWorkflowPlanStep | null;
  nextStepId: string | null;
  blockedReason: string | null;
} {
  const steps = getWorkflowPlanSteps(state);
  const byId = new Map(steps.map(step => [step.step_id, step]));
  for (const step of steps) {
    if (!['pending', 'in_progress'].includes(step.status)) continue;
    if (!step.execution) {
      throw new Error(`workflow step ${step.step_id} is missing execution metadata`);
    }
    if (dependenciesSatisfied(step, byId)) {
      return { step, nextStepId: step.step_id, blockedReason: null };
    }
  }
  const blockedStep = steps.find(step => step.status === 'pending' || step.status === 'in_progress') ?? null;
  if (blockedStep) {
    return {
      step: null,
      nextStepId: blockedStep.step_id,
      blockedReason: `no dependency-satisfied workflow step is ready; next pending step is ${blockedStep.step_id}`,
    };
  }
  return { step: null, nextStepId: null, blockedReason: null };
}

function failedWorkflowStep(steps: PersistedWorkflowPlanStep[]): PersistedWorkflowPlanStep | null {
  return steps.find(step => step.status === 'failed') ?? null;
}

function setPlanCurrentStepId(state: RunState, stepId: string | null): void {
  const plan = state.plan;
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) return;
  const record = plan as Record<string, unknown>;
  record.updated_at = utcNowIso();
  if (stepId) {
    record.current_step_id = stepId;
    return;
  }
  delete record.current_step_id;
}

function ensureWorkflowRunStarted(manager: StateManager, runId: string, workflowId: string): void {
  const state = manager.readState();
  if (state.run_status === 'running') {
    if (state.run_id !== runId || state.workflow_id !== workflowId) {
      throw new Error(
        `cannot start workflow run_id=${runId} while another run is active (${state.run_id ?? 'unknown'}:${state.workflow_id ?? 'unknown'})`,
      );
    }
    return;
  }
  if (state.run_status === 'awaiting_approval') {
    if (state.run_id === runId && state.workflow_id === workflowId) {
      return;
    }
    throw new Error('cannot run while status is awaiting_approval; approve or reject the pending gate first');
  }
  if (state.run_status === 'paused' || state.run_status === 'blocked' || state.run_status === 'needs_recovery') {
    throw new Error(`cannot run while status is ${state.run_status}; resume or recover the current run first`);
  }
  if (state.run_status === 'idle') {
    manager.createRun(state, runId, workflowId);
    return;
  }
  state.run_id = runId;
  state.workflow_id = workflowId;
  state.run_status = 'running';
  state.notes = `workflow run resumed: ${runId}`;
  state.checkpoints.last_checkpoint_at = utcNowIso();
  manager.saveStateWithLedger(state, 'workflow_run_resumed', {
    details: { run_id: runId, workflow_id: workflowId },
  });
}

function workflowControlStatus(manager: StateManager, state: RunState): string | null {
  const sentinel = manager.checkStopPause();
  if (sentinel === 'pause' && state.run_status !== 'paused') {
    manager.pauseRun(state, 'paused by sentinel');
  } else if (sentinel === 'stop' && state.run_status === 'running') {
    state.run_status = 'blocked';
    state.notes = 'workflow stopped by sentinel';
    manager.saveStateWithLedger(state, 'workflow_stopped');
  }
  if (state.pending_approval || state.run_status === 'awaiting_approval') return 'requires_approval';
  if (state.run_status === 'paused' || state.run_status === 'blocked' || state.run_status === 'needs_recovery') {
    return state.run_status;
  }
  return null;
}

function emitWorkflowControlStatus(io: CliIo, state: RunState, status: string): number {
  io.stdout(`${JSON.stringify({
    status, run_status: state.run_status, run_id: state.run_id, workflow_id: state.workflow_id,
    ...(state.pending_approval ? {
      gate_id: state.pending_approval.category,
      approval_id: state.pending_approval.approval_id,
      packet_path: state.pending_approval.packet_path,
    } : {}),
  }, null, 2)}\n`);
  return status === 'needs_recovery' ? 1 : 0;
}

function stopUnknownWorkflowOutcome(
  manager: StateManager, io: CliIo, stepId: string, reason: string,
): number {
  const state = manager.readState();
  // Preserve an operator pause or approval, while keeping the dispatch journal
  // unknown. Neither resume nor a repeated run can make that attempt safe.
  if (state.run_status === 'running') state.run_status = 'needs_recovery';
  state.notes = `workflow step ${stepId} outcome unknown: ${reason}; reconcile before dispatching again`;
  manager.saveStateWithLedger(state, 'workflow_step_outcome_unknown', {
    step_id: stepId, details: { reason },
  });
  io.stdout(`${JSON.stringify({
    status: 'outcome_unknown', ok: false, run_status: state.run_status,
    run_id: state.run_id, workflow_id: state.workflow_id, step_id: stepId, error: state.notes,
  }, null, 2)}\n`);
  return 1;
}

async function runWorkflowCommand(
  resolved: WorkflowResolvedRunInput,
  deps: RunCommandDeps,
  io: CliIo,
): Promise<number> {
  const manager = new StateManager(resolved.projectRoot);
  const initialState = manager.readState();
  if (initialState.run_id !== resolved.runId
    && ['running', 'paused', 'awaiting_approval', 'blocked', 'needs_recovery'].includes(initialState.run_status)) {
    throw new Error(`cannot start workflow run_id=${resolved.runId} while another run is active (${initialState.run_id}:${initialState.workflow_id})`);
  }
  if (!resolved.dryRun) {
    const controlStatus = workflowControlStatus(manager, initialState);
    if (controlStatus) return emitWorkflowControlStatus(io, initialState, controlStatus);
  }
  const selection = selectNextWorkflowStep(initialState);

  if (
    !resolved.dryRun
    && initialState.run_status === 'awaiting_approval'
    && initialState.run_id === resolved.runId
    && initialState.workflow_id === resolved.workflowId
    && initialState.pending_approval
  ) {
    io.stdout(`${JSON.stringify({
      status: 'requires_approval',
      gate_id: initialState.pending_approval.category,
      run_id: resolved.runId,
      workflow_id: resolved.workflowId,
      approval_id: initialState.pending_approval.approval_id,
      packet_path: initialState.pending_approval.packet_path,
    }, null, 2)}\n`);
    return 0;
  }

  if (!selection.step && !selection.blockedReason) {
    const failedStep = failedWorkflowStep(getWorkflowPlanSteps(initialState));
    if (failedStep) {
      const message = `workflow plan contains failed step ${failedStep.step_id}; recover or replace the plan before rerunning`;
      if (resolved.dryRun) {
        io.stdout(`${JSON.stringify({
          status: 'dry_run',
          validated: false,
          dry_run: true,
          run_id: resolved.runId,
          workflow_id: resolved.workflowId,
          next_step_id: failedStep.step_id,
          step: null,
          blocked_reason: message,
        }, null, 2)}\n`);
        return 0;
      }
      initialState.run_status = 'failed';
      initialState.current_step = null;
      initialState.notes = message;
      setPlanCurrentStepId(initialState, null);
      manager.saveStateWithLedger(initialState, 'workflow_step_selection_failed', {
        details: {
          run_id: resolved.runId,
          workflow_id: resolved.workflowId,
          reason: message,
          failed_step_id: failedStep.step_id,
        },
      });
      io.stdout(`${JSON.stringify({
        status: 'failed',
        ok: false,
        run_id: resolved.runId,
        workflow_id: resolved.workflowId,
        step_id: failedStep.step_id,
        error: message,
      }, null, 2)}\n`);
      return 1;
    }
    if (resolved.dryRun) {
      io.stdout(`${JSON.stringify({
        status: 'dry_run',
        validated: true,
        dry_run: true,
        run_id: resolved.runId,
        workflow_id: resolved.workflowId,
        next_step_id: null,
        step: null,
        blocked_reason: null,
      }, null, 2)}\n`);
      return 0;
    }
    if (initialState.run_status !== 'completed') {
      initialState.run_status = 'completed';
      initialState.current_step = null;
      setPlanCurrentStepId(initialState, null);
      manager.saveStateWithLedger(initialState, 'workflow_plan_completed', {
        details: { run_id: resolved.runId, workflow_id: resolved.workflowId },
      });
    }
    const acceptance = evaluateWorkflowAcceptance(manager, deps.workflowAcceptance);
    const exitCode = workflowAcceptanceExitCode(acceptance);
    io.stdout(`${JSON.stringify({
      status: 'completed',
      ok: exitCode === 0,
      workflow_acceptance: acceptance,
      run_id: resolved.runId,
      workflow_id: resolved.workflowId,
      message: 'workflow plan has no pending executable steps',
    }, null, 2)}\n`);
    return exitCode;
  }

  if (resolved.dryRun) {
    io.stdout(`${JSON.stringify({
      status: 'dry_run',
      validated: true,
      dry_run: true,
      run_id: resolved.runId,
      workflow_id: resolved.workflowId,
      next_step_id: selection.nextStepId,
      step: selection.step ? {
        step_id: selection.step.step_id,
        description: selection.step.description,
        execution: selection.step.execution,
      } : null,
      blocked_reason: selection.blockedReason,
    }, null, 2)}\n`);
    return 0;
  }

  ensureWorkflowRunStarted(manager, resolved.runId, resolved.workflowId);
  const journal = new RunManifestManager(path.dirname(runDirFor(resolved.projectRoot, resolved.runId)));
  const executedStepIds: string[] = [];
  let lastStepId: string | null = null;
  let lastTool: string | null = null;
  let lastProvider: string | null = null;
  let lastPayload: unknown = null;
  const aggregateDiagnostics: Awaited<ReturnType<typeof executeWorkflowRuntimeRequest>>['diagnostics'] = [];
  let sawPartial = false;
  let sawSkipped = false;
  let lastSkipReason: string | null = null;

  while (true) {
    const state = manager.readState();
    const controlStatus = workflowControlStatus(manager, state);
    if (controlStatus) return emitWorkflowControlStatus(io, state, controlStatus);
    const { step, blockedReason } = selectNextWorkflowStep(state);
    if (!step) {
      if (blockedReason) {
        state.run_status = 'failed';
        state.current_step = null;
        state.notes = blockedReason;
        setPlanCurrentStepId(state, null);
        manager.saveStateWithLedger(state, 'workflow_step_selection_failed', {
          details: { run_id: resolved.runId, workflow_id: resolved.workflowId, reason: blockedReason },
        });
        io.stdout(`${JSON.stringify({
          status: 'failed',
          ok: false,
          run_id: resolved.runId,
          workflow_id: resolved.workflowId,
          ...(lastStepId ? { step_id: lastStepId } : {}),
          ...(executedStepIds.length > 0 ? { executed_step_ids: executedStepIds } : {}),
          error: blockedReason,
        }, null, 2)}\n`);
        return 1;
      }
      if (executedStepIds.length === 0) {
        throw new Error('workflow step selection drifted after startup; retry the run command');
      }
      const finalState = manager.readState();
      const acceptance = evaluateWorkflowAcceptance(manager, deps.workflowAcceptance);
      const exitCode = workflowAcceptanceExitCode(acceptance);
      io.stdout(`${JSON.stringify({
        status: 'completed',
        ok: exitCode === 0,
        workflow_acceptance: acceptance,
        ...(sawPartial ? { partial: true } : {}),
        ...(sawSkipped ? { skipped: true } : {}),
        run_id: resolved.runId,
        workflow_id: resolved.workflowId,
        step_id: lastStepId,
        ...(lastTool ? { tool: lastTool } : {}),
        ...(lastProvider ? { provider: lastProvider } : {}),
        executed_step_ids: executedStepIds,
        next_step_id: null,
        run_status: finalState.run_status,
        result: lastPayload,
        ...(sawSkipped && lastSkipReason ? { reason: lastSkipReason } : {}),
        ...(aggregateDiagnostics.length > 0 ? { diagnostics: aggregateDiagnostics } : {}),
      }, null, 2)}\n`);
      return exitCode;
    }

    const startedAt = utcNowIso();
    manager.syncPlanCurrentStep(state, step.step_id, step.description);
    state.current_step = {
      step_id: step.step_id,
      title: step.description,
      started_at: startedAt,
    };
    state.notes = `running workflow step ${step.step_id}`;
    manager.saveStateWithLedger(state, 'workflow_step_started', {
      step_id: step.step_id,
      details: {
        workflow_id: resolved.workflowId,
        tool: step.execution?.tool ?? null,
        provider: step.execution?.provider ?? null,
      },
    });

    let runtimeRequest: ReturnType<typeof compileWorkflowRuntimeRequest>;
    let runtimeResult: Awaited<ReturnType<typeof executeWorkflowRuntimeRequest>>;
    try {
      runtimeRequest = compileWorkflowRuntimeRequest({
        projectRoot: resolved.projectRoot,
        workflowId: resolved.workflowId,
        runId: resolved.runId,
        step,
      });
      const attempt = createToolAttemptIdentity({
        stepId: step.step_id, toolName: runtimeRequest.tool, input: runtimeRequest,
      });
      const classification = journal.classifyToolAttempt(resolved.runId, attempt);
      if (classification.state === 'outcome_unknown'
        || (classification.state === 'missing' && step.status === 'in_progress')) {
        return stopUnknownWorkflowOutcome(manager, io, step.step_id,
          classification.state === 'missing' ? 'missing_durable_intent' : 'dispatch_interrupted');
      }
      if (classification.state === 'committed') {
        if (parseRunGateApprovalRequest(runtimeRequest.tool, classification.result, resolveToolExecutionPolicy(runtimeRequest.tool))) {
          throw new Error('committed approval response requires reconciliation before the workflow step can execute');
        }
        runtimeResult = normalizeWorkflowRuntimeResult(runtimeRequest, classification.result);
      } else {
        const pendingIntent = journal.loadManifest(resolved.runId)?.pending_tool_intents.find(intent => intent.step_id === step.step_id);
        const boundary = pendingIntent?.last_approval_boundary;
        if (boundary) {
          const gateState = manager.readState();
          if (gateState.gate_satisfied[boundary.gate_id] !== boundary.approval_id
            || !gateState.approval_history.some(entry => entry.approval_id === boundary.approval_id
              && entry.category === boundary.gate_id && entry.decision === 'approved')) {
            throw new Error('workflow approval boundary requires canonical approval before another dispatch');
          }
        }
        journal.observeToolIntents(resolved.runId, [attempt]);
        let haltedStatus: string | null = null;
        let returnedApproval: RunGateApprovalRequest | null = null;
        let rejectedApprovalError: Error | null = null;
        runtimeResult = await executeWorkflowRuntimeRequest(runtimeRequest, {
          ...deps,
          aroundDispatch: async (dispatch, request) => {
            const boundaryState = manager.readState();
            haltedStatus = workflowControlStatus(manager, boundaryState);
            if (haltedStatus) throw new Error(`workflow dispatch halted: ${haltedStatus}`);
            journal.markToolIntentsDispatched(resolved.runId, [attempt]);
            const response = await dispatch();
            try {
              const approval = parseRunGateApprovalRequest(request.tool, response, resolveToolExecutionPolicy(request.tool));
              if (approval) {
                const gateState = manager.readState();
                const pending = gateState.pending_approval;
                if (approval.runId !== resolved.runId || gateState.run_id !== resolved.runId
                  || gateState.workflow_id !== resolved.workflowId || !pending
                  || pending.approval_id !== approval.approvalId || pending.category !== approval.gateId
                  || pending.packet_path !== approval.packetPath || !pending.plan_step_ids.includes(step.step_id)
                  || (gateState.run_status !== 'awaiting_approval' && gateState.run_status !== 'paused')) {
                  throw new Error('workflow approval response has no matching canonical pending approval');
                }
                journal.resetOutcomeUnknownAtApprovalBoundary(resolved.runId, attempt, {
                  authority: approval.authority, gate_id: approval.gateId, run_id: approval.runId,
                  approval_id: approval.approvalId, packet_path: approval.packetPath,
                  approval_packet_sha256: approval.approvalPacketSha256,
                });
                returnedApproval = approval;
                return;
              }
            } catch (error) {
              // Preserve the rejected envelope as committed evidence, then
              // fail closed. It must never be projected as completed work.
              rejectedApprovalError = error instanceof Error ? error : new Error(String(error));
              journal.commitToolAttempt(resolved.runId, attempt, response);
              throw error;
            }
            // Commit before normalization, artifacts, and plan projection. A
            // response can replay after any crash in those later operations.
            journal.commitToolAttempt(resolved.runId, attempt, response);
          },
        });
        if (rejectedApprovalError) throw rejectedApprovalError;
        if (haltedStatus) return emitWorkflowControlStatus(io, manager.readState(), haltedStatus);
        if (returnedApproval) return emitWorkflowControlStatus(io, manager.readState(), 'requires_approval');
        if (journal.classifyToolAttempt(resolved.runId, attempt).state === 'outcome_unknown') {
          return stopUnknownWorkflowOutcome(manager, io, step.step_id, 'dispatch_interrupted');
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const diagnosticCode = classifyWorkflowCompileDiagnostic(message);
      const persisted = manager.readState();
      const failureControl = workflowControlStatus(manager, persisted);
      const failureControlNotes = persisted.notes;
      manager.syncPlanTerminal(persisted, step.step_id, step.description, 'failed');
      persisted.current_step = null;
      if (!failureControl) persisted.run_status = 'failed';
      setPlanCurrentStepId(persisted, null);
      const artifactKey = artifactKeyForWorkflowStep(step);
      const recovery = projectWorkflowTerminalStep({
        projectRoot: resolved.projectRoot,
        state: persisted,
        step,
        tool: step.execution?.tool ?? artifactKey,
        artifactKey,
        runtimeStatus: 'failed',
        artifactUri: null,
        additionalArtifactUris: [],
        summaryText: message,
        payload: null,
        diagnostics: [{ code: diagnosticCode, details: { reason: null } }],
      });
      if (failureControl) persisted.notes = failureControlNotes;
      manager.saveStateWithLedger(persisted, 'workflow_step_failed', {
        step_id: step.step_id,
        details: {
          workflow_id: resolved.workflowId,
          tool: step.execution?.tool ?? null,
          degrade_mode: step.execution?.degrade_mode ?? 'fail_closed',
          artifact_key: artifactKey,
          error: message,
          next_step_id: null,
          reason_code: recovery.reasonCode,
          recoverable: recovery.recoverable,
          diagnostics: [{ code: diagnosticCode, message }],
        },
      });
      io.stdout(`${JSON.stringify({
        status: 'failed',
        ok: false,
        run_id: resolved.runId,
        workflow_id: resolved.workflowId,
        step_id: step.step_id,
        ...(executedStepIds.length > 0 ? { executed_step_ids: executedStepIds } : {}),
        error: message,
        diagnostics: [{ code: diagnosticCode, message }],
      }, null, 2)}\n`);
      return 1;
    }
    const persisted = manager.readState();
    const persistedControl = workflowControlStatus(manager, persisted);
    const controlNotes = persisted.notes;

    if (runtimeResult.status === 'completed' || runtimeResult.status === 'partial') {
      manager.syncPlanTerminal(persisted, step.step_id, step.description, 'completed');
      persisted.current_step = null;
      const nextSelection = selectNextWorkflowStep(persisted);
      setPlanCurrentStepId(persisted, nextSelection.blockedReason ? null : nextSelection.nextStepId);
      if (!persistedControl && !nextSelection.blockedReason && nextSelection.nextStepId === null) {
        persisted.run_status = 'completed';
      }
      const artifactKey = runtimeRequest.artifact_key;
      const artifactUri = runtimeResult.canonical_artifact_uri;
      const recovery = projectWorkflowTerminalStep({
        projectRoot: resolved.projectRoot,
        state: persisted,
        step,
        tool: step.execution?.tool ?? runtimeRequest.tool,
        artifactKey,
        runtimeStatus: runtimeResult.status,
        artifactUri,
        additionalArtifactUris: runtimeResult.additional_artifact_uris,
        summaryText: runtimeResult.summary_text,
        payload: runtimeResult.payload,
        diagnostics: runtimeResult.diagnostics,
      });
      if (persistedControl) persisted.notes = controlNotes;
      manager.saveStateWithLedger(persisted, 'workflow_step_completed', {
        step_id: step.step_id,
        details: {
          workflow_id: resolved.workflowId,
          tool: step.execution?.tool ?? null,
          next_step_id: nextSelection.nextStepId,
          artifact_key: artifactKey,
          artifact_uri: artifactUri,
          runtime_status: runtimeResult.status,
          reason_code: recovery.reasonCode,
          recoverable: recovery.recoverable,
        },
      });
      executedStepIds.push(step.step_id);
      lastStepId = step.step_id;
      lastTool = step.execution?.tool ?? null;
      lastProvider = step.execution?.provider ?? null;
      lastPayload = runtimeResult.payload;
      aggregateDiagnostics.push(...runtimeResult.diagnostics);
      if (runtimeResult.status === 'partial') {
        sawPartial = true;
      }
      if (persistedControl) return emitWorkflowControlStatus(io, persisted, persistedControl);
      if (nextSelection.blockedReason) {
        const blockedState = manager.readState();
        blockedState.run_status = 'failed';
        blockedState.notes = nextSelection.blockedReason;
        setPlanCurrentStepId(blockedState, null);
        manager.saveStateWithLedger(blockedState, 'workflow_step_selection_failed', {
          details: {
            run_id: resolved.runId,
            workflow_id: resolved.workflowId,
            reason: nextSelection.blockedReason,
            previous_step_id: step.step_id,
          },
        });
        io.stdout(`${JSON.stringify({
          status: 'failed',
          ok: false,
          run_id: resolved.runId,
          workflow_id: resolved.workflowId,
          step_id: step.step_id,
          executed_step_ids: executedStepIds,
          error: nextSelection.blockedReason,
          ...(aggregateDiagnostics.length > 0 ? { diagnostics: aggregateDiagnostics } : {}),
        }, null, 2)}\n`);
        return 1;
      }
      if (nextSelection.nextStepId !== null) continue;
      continue;
    }

    const message = runtimeResult.summary_text;
    const terminalStatus = runtimeResult.status === 'skipped' ? 'skipped' : 'failed';
    manager.syncPlanTerminal(persisted, step.step_id, step.description, terminalStatus);
    persisted.current_step = null;
    persisted.notes = message;
    const nextSelection = terminalStatus === 'skipped'
      ? selectNextWorkflowStep(persisted)
      : { nextStepId: null, blockedReason: null };
    setPlanCurrentStepId(persisted, nextSelection.blockedReason ? null : nextSelection.nextStepId);
    if (!persistedControl && terminalStatus === 'failed') {
      persisted.run_status = 'failed';
    } else if (!persistedControl && !nextSelection.blockedReason && nextSelection.nextStepId === null) {
      persisted.run_status = 'completed';
    }
    const recovery = projectWorkflowTerminalStep({
      projectRoot: resolved.projectRoot,
      state: persisted,
      step,
      tool: step.execution?.tool ?? runtimeRequest.tool,
      artifactKey: runtimeRequest.artifact_key,
      runtimeStatus: terminalStatus,
      artifactUri: runtimeResult.canonical_artifact_uri,
      additionalArtifactUris: runtimeResult.additional_artifact_uris,
      summaryText: runtimeResult.summary_text,
      payload: runtimeResult.payload,
      diagnostics: runtimeResult.diagnostics,
    });
    if (persistedControl) persisted.notes = controlNotes;
    manager.saveStateWithLedger(persisted, terminalStatus === 'skipped' ? 'workflow_step_skipped' : 'workflow_step_failed', {
      step_id: step.step_id,
      details: {
        workflow_id: resolved.workflowId,
        tool: step.execution?.tool ?? null,
        degrade_mode: runtimeRequest.degrade_mode,
        artifact_key: runtimeRequest.artifact_key,
        error: message,
        next_step_id: nextSelection.nextStepId,
        ...(runtimeResult.canonical_artifact_uri
          ? {
              artifact_uri: runtimeResult.canonical_artifact_uri,
            }
          : {}),
        reason_code: recovery.reasonCode,
        recoverable: recovery.recoverable,
        diagnostics: runtimeResult.diagnostics,
      },
    });
    if (persistedControl) return emitWorkflowControlStatus(io, persisted, persistedControl);
    if (terminalStatus === 'skipped') {
      executedStepIds.push(step.step_id);
      lastStepId = step.step_id;
      lastTool = step.execution?.tool ?? null;
      lastProvider = step.execution?.provider ?? null;
      lastPayload = null;
      sawSkipped = true;
      lastSkipReason = message;
      aggregateDiagnostics.push(...runtimeResult.diagnostics);
      if (nextSelection.blockedReason) {
        const blockedState = manager.readState();
        blockedState.run_status = 'failed';
        blockedState.notes = nextSelection.blockedReason;
        setPlanCurrentStepId(blockedState, null);
        manager.saveStateWithLedger(blockedState, 'workflow_step_selection_failed', {
          details: {
            run_id: resolved.runId,
            workflow_id: resolved.workflowId,
            reason: nextSelection.blockedReason,
            previous_step_id: step.step_id,
          },
        });
        io.stdout(`${JSON.stringify({
          status: 'failed',
          ok: false,
          run_id: resolved.runId,
          workflow_id: resolved.workflowId,
          step_id: step.step_id,
          executed_step_ids: executedStepIds,
          error: nextSelection.blockedReason,
          diagnostics: aggregateDiagnostics,
        }, null, 2)}\n`);
        return 1;
      }
      if (nextSelection.nextStepId !== null) continue;
      continue;
    }
    io.stdout(`${JSON.stringify({
      status: 'failed',
      ok: false,
      run_id: resolved.runId,
      workflow_id: resolved.workflowId,
      step_id: step.step_id,
      ...(executedStepIds.length > 0 ? { executed_step_ids: executedStepIds } : {}),
      error: message,
      diagnostics: runtimeResult.diagnostics,
    }, null, 2)}\n`);
    return 1;
  }
}

export async function runCommand(input: RunCommandInput, io: CliIo, deps: RunCommandDeps = {}): Promise<number> {
  const resolved = resolveRunInput(input, io);
  assertWritableRunId(resolved.projectRoot, resolved.runId);
  if (resolved.kind === 'workflow') {
    return runWorkflowCommand(resolved, deps, io);
  }
  assertExecutionRunDirectory(resolved.runDir, resolved.projectRoot, resolved.runId);
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

export async function runComputationCommand(input: RunCommandInput, io: CliIo): Promise<number> {
  return runCommand(input, io);
}
