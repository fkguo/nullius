import * as fs from 'node:fs';
import * as path from 'node:path';
import { executeComputationManifest } from './computation/index.js';
import type { CliIo } from './cli-lifecycle.js';
import { resolveLifecycleProjectRoot } from './cli-project-root.js';
import { resolveUserPath } from './project-policy.js';
import { StateManager } from './state-manager.js';
import type { RunState, WorkflowOutputView } from './types.js';
import { utcNowIso } from './util.js';
import {
  compileWorkflowRuntimeRequest,
  executeWorkflowRuntimeRequest,
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
  runtimeStatus: 'completed' | 'partial';
  artifactUri: string | null;
  additionalArtifactUris: string[];
  summaryText: string;
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
    payload,
    payload_truncated: payloadTruncated,
  };
}

function isWithinPath(basePath: string, candidatePath: string): boolean {
  const relative = path.relative(path.resolve(basePath), path.resolve(candidatePath));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function normalizeRunId(raw: string | null): string {
  const runId = (raw ?? '').trim();
  if (!runId) {
    throw new Error('run requires --run-id <id> (or an existing state.run_id)');
  }
  if (!/^[A-Za-z0-9._-]+$/.test(runId) || runId.includes('..')) {
    throw new Error(`run_id must be a simple identifier, got: ${runId}`);
  }
  return runId;
}

function resolveRunInput(input: RunCommandInput, io: CliIo): AnyResolvedRunInput {
  const projectRoot = resolveLifecycleProjectRoot(input.projectRoot, io.cwd);
  const manager = new StateManager(projectRoot);
  if (!fs.existsSync(manager.statePath)) {
    throw new Error(`project root is not initialized: ${projectRoot}; run autoresearch init first`);
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
  const runDir = input.runDir ? resolveUserPath(input.runDir, io.cwd) : path.join(projectRoot, runId);
  if (!isWithinPath(projectRoot, runDir)) {
    throw new Error(`run dir must stay within project root: ${runDir}`);
  }
  const manifestPath = input.manifestPath
    ? resolveUserPath(input.manifestPath, io.cwd)
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

async function runWorkflowCommand(
  resolved: WorkflowResolvedRunInput,
  deps: RunCommandDeps,
  io: CliIo,
): Promise<number> {
  const manager = new StateManager(resolved.projectRoot);
  const initialState = manager.readState();
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
    io.stdout(`${JSON.stringify({
      status: 'completed',
      ok: true,
      run_id: resolved.runId,
      workflow_id: resolved.workflowId,
      message: 'workflow plan has no pending executable steps',
    }, null, 2)}\n`);
    return 0;
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
      io.stdout(`${JSON.stringify({
        status: 'completed',
        ok: true,
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
      return 0;
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
      runtimeResult = await executeWorkflowRuntimeRequest(runtimeRequest, deps);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const diagnosticCode = classifyWorkflowCompileDiagnostic(message);
      const persisted = manager.readState();
      manager.syncPlanTerminal(persisted, step.step_id, step.description, 'failed');
      persisted.current_step = null;
      persisted.run_status = 'failed';
      persisted.notes = message;
      setPlanCurrentStepId(persisted, null);
      manager.saveStateWithLedger(persisted, 'workflow_step_failed', {
        step_id: step.step_id,
        details: {
          workflow_id: resolved.workflowId,
          tool: step.execution?.tool ?? null,
          degrade_mode: step.execution?.degrade_mode ?? 'fail_closed',
          error: message,
          next_step_id: null,
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

    if (runtimeResult.status === 'completed' || runtimeResult.status === 'partial') {
      manager.syncPlanTerminal(persisted, step.step_id, step.description, 'completed');
      persisted.current_step = null;
      const nextSelection = selectNextWorkflowStep(persisted);
      setPlanCurrentStepId(persisted, nextSelection.blockedReason ? null : nextSelection.nextStepId);
      if (!nextSelection.blockedReason && nextSelection.nextStepId === null) {
        persisted.run_status = 'completed';
      }
      const artifactKey = runtimeRequest.artifact_key;
      const artifactUri = runtimeResult.canonical_artifact_uri;
      if (artifactUri) {
        persisted.artifacts[artifactKey] = artifactUri;
      }
      persisted.workflow_outputs[artifactKey] = buildWorkflowOutputView({
        stepId: step.step_id,
        tool: step.execution?.tool ?? runtimeRequest.tool,
        runtimeStatus: runtimeResult.status,
        artifactUri,
        additionalArtifactUris: runtimeResult.additional_artifact_uris,
        summaryText: runtimeResult.summary_text,
        payload: runtimeResult.payload,
      });
      persisted.notes = runtimeResult.summary_text.slice(0, 2000);
      manager.saveStateWithLedger(persisted, 'workflow_step_completed', {
        step_id: step.step_id,
        details: {
          workflow_id: resolved.workflowId,
          tool: step.execution?.tool ?? null,
          next_step_id: nextSelection.nextStepId,
          artifact_key: artifactKey,
          artifact_uri: artifactUri,
          runtime_status: runtimeResult.status,
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
    if (terminalStatus === 'failed') {
      persisted.run_status = 'failed';
    } else if (!nextSelection.blockedReason && nextSelection.nextStepId === null) {
      persisted.run_status = 'completed';
    }
    if (terminalStatus === 'skipped' && runtimeResult.canonical_artifact_uri) {
      persisted.artifacts[runtimeRequest.artifact_key] = runtimeResult.canonical_artifact_uri;
    }
    manager.saveStateWithLedger(persisted, terminalStatus === 'skipped' ? 'workflow_step_skipped' : 'workflow_step_failed', {
      step_id: step.step_id,
      details: {
        workflow_id: resolved.workflowId,
        tool: step.execution?.tool ?? null,
        degrade_mode: runtimeRequest.degrade_mode,
        error: message,
        next_step_id: nextSelection.nextStepId,
        ...(terminalStatus === 'skipped' && runtimeResult.canonical_artifact_uri
          ? {
              artifact_key: runtimeRequest.artifact_key,
              artifact_uri: runtimeResult.canonical_artifact_uri,
            }
          : {}),
        diagnostics: runtimeResult.diagnostics,
      },
    });
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
  if (resolved.kind === 'workflow') {
    return runWorkflowCommand(resolved, deps, io);
  }
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
