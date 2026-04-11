import { describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runCommand, type RunCommandInput } from '../src/cli-run.js';
import { StateManager } from '../src/state-manager.js';

function makeTempProjectRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'autoresearch-run-workflow-'));
}

function makeIo(cwd: string) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    io: {
      cwd,
      stderr: (text: string) => stderr.push(text),
      stdout: (text: string) => stdout.push(text),
    },
    stdout,
    stderr,
  };
}

function makeRunInput(projectRoot: string, workflowId: string, runId: string, dryRun = false): RunCommandInput {
  return {
    command: 'run',
    projectRoot,
    workflowId,
    runId,
    runDir: null,
    manifestPath: null,
    dryRun,
  };
}

async function withEnv<T>(
  env: Record<string, string | undefined>,
  fn: () => Promise<T>,
): Promise<T> {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(env)) {
    previous.set(key, process.env[key]);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of previous.entries()) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

function persistWorkflowPlan(projectRoot: string, options?: {
  workflowId?: string;
  secondStepDegradeMode?: string | null;
  secondStepDependsOn?: string[];
}): StateManager {
  const manager = new StateManager(projectRoot);
  manager.ensureDirs();
  const workflowId = options?.workflowId ?? 'review_cycle';
  const state = manager.readState();
  state.run_id = 'M-WF-1';
  state.workflow_id = workflowId;
  state.run_status = 'idle';
  state.plan = {
    schema_version: 1,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    plan_id: `M-WF-1:${workflowId}`,
    run_id: 'M-WF-1',
    workflow_id: workflowId,
    current_step_id: 'critical_review',
    steps: [
      {
        step_id: 'critical_review',
        description: 'Critical review',
        status: 'pending',
        expected_approvals: [],
        expected_outputs: ['critical_analysis'],
        recovery_notes: '',
        execution: {
          action: 'analyze.paper_set_critical_review',
          tool: 'inspire_critical_analysis',
          provider: 'inspire',
          depends_on: [],
          params: { recid: '1234' },
          required_capabilities: ['analysis.paper_set_critical_review'],
          degrade_mode: 'fail_closed',
          consumer_hints: { artifact: 'critical_analysis' },
        },
      },
      {
        step_id: 'export_project',
        description: 'Export project',
        status: 'pending',
        expected_approvals: [],
        expected_outputs: ['research_pack'],
        recovery_notes: '',
        execution: {
          action: 'export.project',
          tool: 'hep_export_project',
          provider: 'hep',
          depends_on: options?.secondStepDependsOn ?? ['critical_review'],
          params: { run_id: 'M-WF-1' },
          required_capabilities: [],
          degrade_mode: options?.secondStepDegradeMode ?? 'fail_closed',
          consumer_hints: { artifact: 'research_pack' },
        },
      },
    ],
    notes: '',
  };
  manager.saveState(state);
  return manager;
}

describe('workflow run consumer', () => {
  it('executes one dependency-satisfied persisted workflow step and advances the plan cursor', async () => {
    const projectRoot = makeTempProjectRoot();
    const manager = persistWorkflowPlan(projectRoot);
    const callTool = vi.fn(async () => ({
      ok: true,
      isError: false,
      rawText: JSON.stringify({ uri: 'hep://runs/M-WF-1/artifact/critical_analysis.json' }),
      json: { uri: 'hep://runs/M-WF-1/artifact/critical_analysis.json' },
      errorCode: null,
    }));
    const { io, stdout } = makeIo(projectRoot);

    const code = await runCommand(
      makeRunInput(projectRoot, 'review_cycle', 'M-WF-1'),
      io,
      { workflowToolCaller: { callTool } },
    );

    expect(code).toBe(0);
    expect(callTool).toHaveBeenCalledWith('inspire_critical_analysis', { recid: '1234' });
    expect(JSON.parse(stdout.join(''))).toMatchObject({
      status: 'completed',
      ok: true,
      workflow_id: 'review_cycle',
      step_id: 'critical_review',
      next_step_id: 'export_project',
      run_status: 'running',
    });
    expect(manager.readState()).toMatchObject({
      run_id: 'M-WF-1',
      workflow_id: 'review_cycle',
      run_status: 'running',
      current_step: null,
      artifacts: {
        critical_analysis: 'hep://runs/M-WF-1/artifact/critical_analysis.json',
      },
      plan: {
        current_step_id: 'export_project',
      },
    });
    const steps = ((manager.readState().plan as Record<string, unknown>).steps ?? []) as Array<Record<string, unknown>>;
    expect(steps[0]).toMatchObject({ step_id: 'critical_review', status: 'completed' });
    expect(steps[1]).toMatchObject({ step_id: 'export_project', status: 'pending' });
  });

  it('fails closed when no dependency-satisfied pending workflow step exists', async () => {
    const projectRoot = makeTempProjectRoot();
    const manager = persistWorkflowPlan(projectRoot, {
      secondStepDependsOn: ['missing_step'],
    });
    const state = manager.readState();
    const steps = ((state.plan as Record<string, unknown>).steps ?? []) as Array<Record<string, unknown>>;
    steps[0]!.status = 'completed';
    manager.saveState(state);
    const { io } = makeIo(projectRoot);

    await expect(
      runCommand(makeRunInput(projectRoot, 'review_cycle', 'M-WF-1'), io, {
        workflowToolCaller: { callTool: vi.fn() },
      }),
    ).rejects.toThrow('no dependency-satisfied workflow step is ready; next pending step is export_project');

    expect(manager.readState()).toMatchObject({
      run_status: 'failed',
      current_step: null,
    });
  });

  it('honors skip_with_reason for unsupported workflow step execution', async () => {
    const projectRoot = makeTempProjectRoot();
    const manager = persistWorkflowPlan(projectRoot, {
      secondStepDegradeMode: 'skip_with_reason',
    });
    const state = manager.readState();
    const steps = ((state.plan as Record<string, unknown>).steps ?? []) as Array<Record<string, unknown>>;
    steps[0]!.status = 'completed';
    manager.saveState(state);
    const callTool = vi.fn(async () => {
      throw new Error('tool call denied: hep_export_project is not available');
    });
    const { io, stdout } = makeIo(projectRoot);

    const code = await runCommand(
      makeRunInput(projectRoot, 'review_cycle', 'M-WF-1'),
      io,
      { workflowToolCaller: { callTool } },
    );

    expect(code).toBe(0);
    expect(JSON.parse(stdout.join(''))).toMatchObject({
      status: 'completed',
      ok: true,
      skipped: true,
      step_id: 'export_project',
      next_step_id: null,
    });
    expect(manager.readState()).toMatchObject({
      run_status: 'completed',
      current_step: null,
    });
    const persistedSteps = (((manager.readState().plan as Record<string, unknown>).steps) ?? []) as Array<Record<string, unknown>>;
    expect(persistedSteps[1]).toMatchObject({ step_id: 'export_project', status: 'skipped' });
  });

  it('surfaces partial_result through the existing completed envelope plus diagnostics', async () => {
    const projectRoot = makeTempProjectRoot();
    const manager = persistWorkflowPlan(projectRoot, {
      secondStepDegradeMode: 'partial_result',
    });
    const state = manager.readState();
    const steps = ((state.plan as Record<string, unknown>).steps ?? []) as Array<Record<string, unknown>>;
    steps[0]!.status = 'completed';
    manager.saveState(state);
    const { io, stdout } = makeIo(projectRoot);

    const code = await runCommand(
      makeRunInput(projectRoot, 'review_cycle', 'M-WF-1'),
      io,
      {
        workflowToolCaller: {
          callTool: vi.fn(async () => ({
            ok: false,
            isError: true,
            rawText: 'upstream timeout after partial export',
            json: null,
            errorCode: 'TIMEOUT',
          })),
        },
      },
    );

    expect(code).toBe(0);
    expect(JSON.parse(stdout.join(''))).toMatchObject({
      status: 'completed',
      ok: true,
      partial: true,
      step_id: 'export_project',
    });
    expect(manager.readState()).toMatchObject({
      run_status: 'completed',
      current_step: null,
    });
    const persistedSteps = (((manager.readState().plan as Record<string, unknown>).steps) ?? []) as Array<Record<string, unknown>>;
    expect(persistedSteps[1]).toMatchObject({ step_id: 'export_project', status: 'completed' });
  });

  it('fails closed when no MCP tool caller is configured', async () => {
    const projectRoot = makeTempProjectRoot();
    persistWorkflowPlan(projectRoot);
    const { io, stdout } = makeIo(projectRoot);

    await withEnv({
      AUTORESEARCH_RUN_MCP_COMMAND: undefined,
      AUTORESEARCH_RUN_MCP_ARGS_JSON: undefined,
      AUTORESEARCH_RUN_MCP_ENV_JSON: undefined,
    }, async () => {
      await expect(runCommand(makeRunInput(projectRoot, 'review_cycle', 'M-WF-1'), io)).resolves.toBe(1);
      expect(JSON.parse(stdout.join(''))).toMatchObject({
        status: 'failed',
        ok: false,
        step_id: 'critical_review',
        error:
        'workflow step execution requires a configured MCP tool server; set AUTORESEARCH_RUN_MCP_COMMAND and optional AUTORESEARCH_RUN_MCP_ARGS_JSON/AUTORESEARCH_RUN_MCP_ENV_JSON',
      });
    });
  });

  it('does not treat missing MCP infrastructure as skippable even when the step degrade_mode is skip_with_reason', async () => {
    const projectRoot = makeTempProjectRoot();
    const manager = persistWorkflowPlan(projectRoot, {
      secondStepDegradeMode: 'skip_with_reason',
    });
    const state = manager.readState();
    const steps = ((state.plan as Record<string, unknown>).steps ?? []) as Array<Record<string, unknown>>;
    steps[0]!.status = 'completed';
    manager.saveState(state);
    const { io, stdout } = makeIo(projectRoot);

    await withEnv({
      AUTORESEARCH_RUN_MCP_COMMAND: undefined,
      AUTORESEARCH_RUN_MCP_ARGS_JSON: undefined,
      AUTORESEARCH_RUN_MCP_ENV_JSON: undefined,
    }, async () => {
      await expect(runCommand(makeRunInput(projectRoot, 'review_cycle', 'M-WF-1'), io)).resolves.toBe(1);
      expect(JSON.parse(stdout.join(''))).toMatchObject({
        status: 'failed',
        ok: false,
        step_id: 'export_project',
        diagnostics: [
          {
            code: 'no_mcp_tool_server',
            message:
              'workflow step execution requires a configured MCP tool server; set AUTORESEARCH_RUN_MCP_COMMAND and optional AUTORESEARCH_RUN_MCP_ARGS_JSON/AUTORESEARCH_RUN_MCP_ENV_JSON',
          },
        ],
      });
    });

    expect(manager.readState()).toMatchObject({
      run_status: 'failed',
      current_step: null,
    });
    const persistedSteps = (((manager.readState().plan as Record<string, unknown>).steps) ?? []) as Array<Record<string, unknown>>;
    expect(persistedSteps[1]).toMatchObject({ step_id: 'export_project', status: 'failed' });
  });

  it('wraps malformed MCP args JSON with a stable fail-closed error', async () => {
    const projectRoot = makeTempProjectRoot();
    persistWorkflowPlan(projectRoot);
    const { io, stdout } = makeIo(projectRoot);

    await withEnv({
      AUTORESEARCH_RUN_MCP_COMMAND: 'mock-mcp',
      AUTORESEARCH_RUN_MCP_ARGS_JSON: '{not-json',
      AUTORESEARCH_RUN_MCP_ENV_JSON: undefined,
    }, async () => {
      await expect(runCommand(makeRunInput(projectRoot, 'review_cycle', 'M-WF-1'), io)).resolves.toBe(1);
      expect(JSON.parse(stdout.join(''))).toMatchObject({
        status: 'failed',
        ok: false,
        step_id: 'critical_review',
        error: 'AUTORESEARCH_RUN_MCP_ARGS_JSON must decode to a JSON string array',
      });
    });
  });

  it('treats rerunning an already completed workflow plan as idempotent completion', async () => {
    const projectRoot = makeTempProjectRoot();
    const manager = persistWorkflowPlan(projectRoot);
    const state = manager.readState();
    const steps = ((state.plan as Record<string, unknown>).steps ?? []) as Array<Record<string, unknown>>;
    steps[0]!.status = 'completed';
    steps[1]!.status = 'completed';
    state.run_status = 'completed';
    state.current_step = null;
    delete (state.plan as Record<string, unknown>).current_step_id;
    manager.saveState(state);
    const beforeLedgerLines = fs.readFileSync(manager.ledgerPath, 'utf-8').trim().split('\n').filter(Boolean).length;
    const { io, stdout } = makeIo(projectRoot);

    const code = await runCommand(makeRunInput(projectRoot, 'review_cycle', 'M-WF-1'), io, {
      workflowToolCaller: { callTool: vi.fn() },
    });

    expect(code).toBe(0);
    expect(JSON.parse(stdout.join(''))).toMatchObject({
      status: 'completed',
      ok: true,
      message: 'workflow plan has no pending executable steps',
    });
    expect(manager.readState().run_status).toBe('completed');
    const afterLedgerLines = fs.readFileSync(manager.ledgerPath, 'utf-8').trim().split('\n').filter(Boolean).length;
    expect(afterLedgerLines).toBe(beforeLedgerLines);
  });

  it('replays the same pending approval when rerunning the active workflow request', async () => {
    const projectRoot = makeTempProjectRoot();
    const manager = persistWorkflowPlan(projectRoot);
    const state = manager.readState();
    state.run_status = 'awaiting_approval';
    state.pending_approval = {
      approval_id: 'A1-0001',
      category: 'A1',
      plan_step_ids: ['critical_review'],
      requested_at: '2026-01-01T00:00:00Z',
      timeout_at: null,
      on_timeout: 'block',
      packet_path: 'artifacts/runs/M-WF-1/approvals/A1-0001/packet.md',
    };
    manager.saveState(state);
    const callTool = vi.fn();
    const { io, stdout } = makeIo(projectRoot);

    const code = await runCommand(makeRunInput(projectRoot, 'review_cycle', 'M-WF-1'), io, {
      workflowToolCaller: { callTool },
    });

    expect(code).toBe(0);
    expect(callTool).not.toHaveBeenCalled();
    expect(JSON.parse(stdout.join(''))).toMatchObject({
      status: 'requires_approval',
      gate_id: 'A1',
      run_id: 'M-WF-1',
      workflow_id: 'review_cycle',
      approval_id: 'A1-0001',
      packet_path: 'artifacts/runs/M-WF-1/approvals/A1-0001/packet.md',
    });
    expect(manager.readState().run_status).toBe('awaiting_approval');
  });

  it('rejects shell-sensitive run identifiers before path resolution', async () => {
    const projectRoot = makeTempProjectRoot();
    const manager = new StateManager(projectRoot);
    manager.ensureDirs();
    manager.saveState(manager.readState());
    const { io } = makeIo(projectRoot);

    await expect(
      runCommand(makeRunInput(projectRoot, 'review_cycle', 'bad:name'), io),
    ).rejects.toThrow('run_id must be a simple identifier, got: bad:name');
  });

});
