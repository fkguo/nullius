import * as fs from 'node:fs';
import * as path from 'node:path';
import { executeComputationManifest } from './computation/index.js';
import type { CliIo } from './cli-lifecycle.js';
import { resolveLifecycleProjectRoot } from './cli-project-root.js';
import { McpClient, type ToolCaller } from './mcp-client.js';
import { resolveUserPath } from './project-policy.js';
import { StateManager } from './state-manager.js';
import type { RunState } from './types.js';
import { utcNowIso } from './util.js';

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

type WorkflowExecutionMetadata = {
  action: string | null;
  tool: string;
  provider: string | null;
  depends_on: string[];
  params: Record<string, unknown>;
  required_capabilities: string[];
  degrade_mode: string | null;
  consumer_hints: Record<string, unknown> | null;
};

type WorkflowPlanStep = {
  step_id: string;
  description: string;
  status: string;
  execution: WorkflowExecutionMetadata | null;
};

type WorkflowToolServerConfig = {
  command: string;
  args: string[];
  env: Record<string, string> | undefined;
};

export type RunCommandDeps = {
  workflowToolCaller?: ToolCaller;
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

function parseWorkflowExecution(raw: unknown): WorkflowExecutionMetadata | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const tool = typeof record.tool === 'string' ? record.tool.trim() : '';
  if (!tool) return null;
  return {
    action: typeof record.action === 'string' && record.action.trim() ? record.action : null,
    tool,
    provider: typeof record.provider === 'string' && record.provider.trim() ? record.provider : null,
    depends_on: Array.isArray(record.depends_on) ? record.depends_on.map(String) : [],
    params: record.params && typeof record.params === 'object' && !Array.isArray(record.params)
      ? { ...(record.params as Record<string, unknown>) }
      : {},
    required_capabilities: Array.isArray(record.required_capabilities)
      ? record.required_capabilities.map(String)
      : [],
    degrade_mode: typeof record.degrade_mode === 'string' && record.degrade_mode.trim() ? record.degrade_mode : null,
    consumer_hints: record.consumer_hints && typeof record.consumer_hints === 'object' && !Array.isArray(record.consumer_hints)
      ? { ...(record.consumer_hints as Record<string, unknown>) }
      : null,
  };
}

function getWorkflowPlanSteps(state: RunState): WorkflowPlanStep[] {
  const plan = state.plan;
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) {
    throw new Error('run requires state.plan to execute a persisted workflow plan');
  }
  const stepsRaw = (plan as Record<string, unknown>).steps;
  if (!Array.isArray(stepsRaw) || stepsRaw.length === 0) {
    throw new Error('run requires state.plan.steps to contain at least one persisted workflow step');
  }
  return stepsRaw.map((rawStep): WorkflowPlanStep => {
    const step = rawStep as Record<string, unknown>;
    return {
      step_id: String(step.step_id ?? ''),
      description: String(step.description ?? ''),
      status: String(step.status ?? 'pending'),
      execution: parseWorkflowExecution(step.execution),
    };
  });
}

function dependenciesSatisfied(step: WorkflowPlanStep, byId: Map<string, WorkflowPlanStep>): boolean {
  return step.execution?.depends_on.every(depId => {
    const dep = byId.get(depId);
    return dep?.status === 'completed' || dep?.status === 'skipped';
  }) ?? true;
}

function selectNextWorkflowStep(state: RunState): {
  step: WorkflowPlanStep | null;
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

function summarizeWorkflowResult(result: unknown): string {
  if (result === null || result === undefined) return '';
  if (typeof result === 'string') return result;
  try {
    return JSON.stringify(result);
  } catch {
    return String(result);
  }
}

function extractArtifactUri(result: unknown): string | null {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return null;
  const record = result as Record<string, unknown>;
  if (typeof record.uri === 'string' && record.uri.trim()) return record.uri;
  const summary = record.summary;
  if (summary && typeof summary === 'object' && !Array.isArray(summary)) {
    const uri = (summary as Record<string, unknown>).uri;
    if (typeof uri === 'string' && uri.trim()) return uri;
  }
  return null;
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

function parseWorkflowJsonEnv<T>(
  name: 'AUTORESEARCH_RUN_MCP_ARGS_JSON' | 'AUTORESEARCH_RUN_MCP_ENV_JSON',
  raw: string,
): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    if (name === 'AUTORESEARCH_RUN_MCP_ARGS_JSON') {
      throw new Error('AUTORESEARCH_RUN_MCP_ARGS_JSON must decode to a JSON string array');
    }
    throw new Error('AUTORESEARCH_RUN_MCP_ENV_JSON must decode to a JSON object');
  }
}

function loadWorkflowToolServerConfigFromEnv(): WorkflowToolServerConfig | null {
  const command = (process.env.AUTORESEARCH_RUN_MCP_COMMAND ?? '').trim();
  if (!command) return null;
  const argsRaw = (process.env.AUTORESEARCH_RUN_MCP_ARGS_JSON ?? '').trim();
  const envRaw = (process.env.AUTORESEARCH_RUN_MCP_ENV_JSON ?? '').trim();
  const args = argsRaw ? parseWorkflowJsonEnv<unknown>('AUTORESEARCH_RUN_MCP_ARGS_JSON', argsRaw) : [];
  if (!Array.isArray(args) || !args.every(item => typeof item === 'string')) {
    throw new Error('AUTORESEARCH_RUN_MCP_ARGS_JSON must decode to a JSON string array');
  }
  let env: Record<string, string> | undefined;
  if (envRaw) {
    const parsed = parseWorkflowJsonEnv<unknown>('AUTORESEARCH_RUN_MCP_ENV_JSON', envRaw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('AUTORESEARCH_RUN_MCP_ENV_JSON must decode to a JSON object');
    }
    env = Object.fromEntries(
      Object.entries(parsed as Record<string, unknown>).map(([key, value]) => [key, String(value)]),
    );
  }
  return { command, args, env };
}

async function withWorkflowToolCaller<T>(deps: RunCommandDeps, fn: (toolCaller: ToolCaller) => Promise<T>): Promise<T> {
  if (deps.workflowToolCaller) {
    return fn(deps.workflowToolCaller);
  }
  const serverConfig = loadWorkflowToolServerConfigFromEnv();
  if (!serverConfig) {
    throw new Error(
      'workflow step execution requires a configured MCP tool server; set AUTORESEARCH_RUN_MCP_COMMAND and optional AUTORESEARCH_RUN_MCP_ARGS_JSON/AUTORESEARCH_RUN_MCP_ENV_JSON',
    );
  }
  const client = new McpClient();
  await client.start(serverConfig.command, serverConfig.args, serverConfig.env);
  try {
    return await fn(client);
  } finally {
    await client.close();
  }
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
  const state = manager.readState();
  const { step, blockedReason } = selectNextWorkflowStep(state);
  if (!step) {
    if (blockedReason) {
      state.run_status = 'failed';
      state.notes = blockedReason;
      manager.saveStateWithLedger(state, 'workflow_step_selection_failed', {
        details: { run_id: resolved.runId, workflow_id: resolved.workflowId, reason: blockedReason },
      });
      throw new Error(blockedReason);
    }
    throw new Error('workflow step selection drifted after startup; retry the run command');
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

  try {
    const toolResult = await withWorkflowToolCaller(deps, toolCaller =>
      toolCaller.callTool(step.execution!.tool, step.execution!.params),
    );
    if (!toolResult.ok || toolResult.isError) {
      throw new Error(toolResult.rawText || `tool call failed: ${step.execution!.tool}`);
    }
    const persisted = manager.readState();
    manager.syncPlanTerminal(persisted, step.step_id, step.description, 'completed');
    persisted.current_step = null;
    const nextSelection = selectNextWorkflowStep(persisted);
    setPlanCurrentStepId(persisted, nextSelection.nextStepId);
    if (nextSelection.nextStepId === null) {
      persisted.run_status = 'completed';
    }
    const artifactKey = typeof step.execution?.consumer_hints?.artifact === 'string'
      ? step.execution.consumer_hints.artifact
      : step.step_id;
    const artifactUri = extractArtifactUri(toolResult.json);
    if (artifactUri) {
      persisted.artifacts[artifactKey] = artifactUri;
    }
    persisted.notes = summarizeWorkflowResult(toolResult.json ?? toolResult.rawText).slice(0, 2000);
    manager.saveStateWithLedger(persisted, 'workflow_step_completed', {
      step_id: step.step_id,
      details: {
        workflow_id: resolved.workflowId,
        tool: step.execution?.tool ?? null,
        next_step_id: nextSelection.nextStepId,
        artifact_key: artifactKey,
        artifact_uri: artifactUri,
      },
    });
    io.stdout(`${JSON.stringify({
      status: 'completed',
      ok: true,
      run_id: resolved.runId,
      workflow_id: resolved.workflowId,
      step_id: step.step_id,
      tool: step.execution?.tool ?? null,
      provider: step.execution?.provider ?? null,
      next_step_id: nextSelection.nextStepId,
      run_status: persisted.run_status,
      result: toolResult.json ?? toolResult.rawText,
    }, null, 2)}\n`);
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const persisted = manager.readState();
    const degradeMode = step.execution?.degrade_mode ?? 'fail_closed';
    const terminalStatus = degradeMode === 'skip_with_reason' ? 'skipped' : 'failed';
    manager.syncPlanTerminal(persisted, step.step_id, step.description, terminalStatus);
    persisted.current_step = null;
    persisted.notes = message;
    const nextSelection = terminalStatus === 'skipped' ? selectNextWorkflowStep(persisted) : { nextStepId: null };
    setPlanCurrentStepId(persisted, nextSelection.nextStepId);
    if (terminalStatus === 'failed') {
      persisted.run_status = 'failed';
    } else if (nextSelection.nextStepId === null) {
      persisted.run_status = 'completed';
    }
    manager.saveStateWithLedger(persisted, terminalStatus === 'skipped' ? 'workflow_step_skipped' : 'workflow_step_failed', {
      step_id: step.step_id,
      details: {
        workflow_id: resolved.workflowId,
        tool: step.execution?.tool ?? null,
        degrade_mode: degradeMode,
        error: message,
        next_step_id: nextSelection.nextStepId,
      },
    });
    if (terminalStatus === 'skipped') {
      io.stdout(`${JSON.stringify({
        status: 'completed',
        ok: true,
        skipped: true,
        run_id: resolved.runId,
        workflow_id: resolved.workflowId,
        step_id: step.step_id,
        next_step_id: nextSelection.nextStepId,
        reason: message,
      }, null, 2)}\n`);
      return 0;
    }
    io.stdout(`${JSON.stringify({
      status: 'failed',
      ok: false,
      run_id: resolved.runId,
      workflow_id: resolved.workflowId,
      step_id: step.step_id,
      error: message,
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
