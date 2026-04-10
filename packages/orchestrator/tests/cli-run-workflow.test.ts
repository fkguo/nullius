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
});
