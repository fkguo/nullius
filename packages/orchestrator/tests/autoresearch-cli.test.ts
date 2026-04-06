import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { StateManager } from '../src/state-manager.js';
import type { RunState } from '../src/types.js';
import { runCli } from '../src/cli.js';

function makeTempProjectRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'autoresearch-cli-'));
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
    stderr,
    stdout,
  };
}

function createComputationFixture(projectRoot: string, runId: string): { runDir: string; manifestPath: string } {
  const runDir = path.join(projectRoot, runId);
  const scriptPath = path.join(runDir, 'computation', 'scripts', 'write_ok.py');
  const manifestPath = path.join(runDir, 'computation', 'manifest.json');
  fs.mkdirSync(path.dirname(scriptPath), { recursive: true });
  fs.writeFileSync(
    scriptPath,
    "from pathlib import Path\nPath('outputs').mkdir(parents=True, exist_ok=True)\nPath('outputs/ok.txt').write_text('ok\\n', encoding='utf-8')\n",
    'utf-8',
  );
  fs.writeFileSync(
    manifestPath,
    JSON.stringify(
      {
        schema_version: 1,
        entry_point: { script: 'scripts/write_ok.py', tool: 'python' },
        steps: [
          {
            id: 'write_ok',
            tool: 'python',
            script: 'scripts/write_ok.py',
            expected_outputs: ['outputs/ok.txt'],
          },
        ],
        environment: { python_version: '3.11', platform: 'any' },
        dependencies: {},
      },
      null,
      2,
    ) + '\n',
    'utf-8',
  );
  return { runDir, manifestPath };
}

function makeAwaitingApprovalState(): { projectRoot: string; approvalId: string } {
  const projectRoot = makeTempProjectRoot();
  const manager = new StateManager(projectRoot);
  manager.ensureDirs();
  const approvalId = 'A1-0001';
  const packetDir = path.join(projectRoot, 'artifacts', 'runs', 'M1', 'approvals', approvalId);
  fs.mkdirSync(packetDir, { recursive: true });
  fs.writeFileSync(path.join(packetDir, 'approval_packet_v1.json'), JSON.stringify({ approval_id: approvalId }, null, 2));
  const state = manager.readState() as RunState;
  state.run_id = 'M1';
  state.workflow_id = 'ingest';
  state.run_status = 'awaiting_approval';
  state.pending_approval = {
    approval_id: approvalId,
    category: 'A1',
    plan_step_ids: [],
    requested_at: '2026-03-23T00:00:00Z',
    timeout_at: null,
    on_timeout: 'block',
    packet_path: path.join('artifacts', 'runs', 'M1', 'approvals', approvalId, 'packet.md'),
  };
  manager.saveState(state);
  return { approvalId, projectRoot };
}

describe('autoresearch CLI', () => {
  it('renders top-level help with the canonical lifecycle scope', async () => {
    const { io, stdout } = makeIo(process.cwd());
    const code = await runCli(['--help'], io);
    expect(code).toBe(0);
    expect(stdout.join('')).toContain('Canonical generic lifecycle and workflow-plan entrypoint');
    expect(stdout.join('')).toContain('autoresearch run --workflow-id computation [options]');
    expect(stdout.join('')).toContain('autoresearch workflow-plan --recipe <recipe_id> [options]');
    expect(stdout.join('')).toContain('Provider-local `doctor`/`bridge` remain on the transitional Pipeline A surface');
  });

  it('resolves launcher-backed workflow plans through the canonical autoresearch front door', async () => {
    const projectRoot = makeTempProjectRoot();
    const manager = new StateManager(projectRoot);
    manager.ensureDirs();
    manager.saveState(manager.readState());
    const { io, stdout } = makeIo(projectRoot);
    const code = await runCli([
      'workflow-plan',
      '--recipe', 'literature_landscape',
      '--phase', 'prework',
      '--run-id', 'M-LIT-1',
      '--query', 'bootstrap amplitudes',
      '--topic', 'bootstrap amplitudes',
      '--seed-recid', '1234',
      '--preferred-provider', 'openalex',
      '--available-tool', 'openalex_search',
      '--available-tool', 'inspire_topic_analysis',
      '--available-tool', 'inspire_network_analysis',
      '--available-tool', 'inspire_trace_original_source',
    ], io);

    expect(code).toBe(0);
    const payload = JSON.parse(stdout.join('')) as {
      recipe_id: string;
      phase?: string;
      entry_tool: string;
      resolved_steps: Array<Record<string, unknown>>;
    };
    expect(payload).toMatchObject({
      recipe_id: 'literature_landscape',
      phase: 'prework',
      entry_tool: 'literature_workflows.resolve',
    });
    expect(payload.resolved_steps[0]).toMatchObject({
      id: 'seed_search',
      provider: 'openalex',
      tool: 'openalex_search',
    });
    expect(manager.readState()).toMatchObject({
      run_id: 'M-LIT-1',
      workflow_id: 'literature_landscape',
      run_status: 'idle',
      plan_md_path: '.autoresearch/plan.md',
      plan: {
        plan_id: 'M-LIT-1:literature_landscape',
      },
    });
    const planMd = fs.readFileSync(path.join(projectRoot, '.autoresearch', 'plan.md'), 'utf-8');
    expect(planMd).toContain('SSOT: `.autoresearch/state.json#/plan`');
    expect(planMd).toContain('seed_search');
  });

  it('fails closed when workflow-plan targets an uninitialized project root', async () => {
    const projectRoot = makeTempProjectRoot();
    const { io } = makeIo(projectRoot);

    await expect(runCli([
      'workflow-plan',
      '--recipe', 'literature_landscape',
      '--query', 'bootstrap amplitudes',
    ], io)).rejects.toThrow(`project root is not initialized: ${projectRoot}; run autoresearch init first`);
  });

  it('rejects workflow-plan replacement while a run is active', async () => {
    const projectRoot = makeTempProjectRoot();
    const manager = new StateManager(projectRoot);
    manager.ensureDirs();
    const state = manager.readState();
    state.run_id = 'M-ACTIVE-1';
    state.workflow_id = 'ingest';
    state.run_status = 'running';
    manager.saveState(state);
    const { io } = makeIo(projectRoot);

    await expect(runCli([
      'workflow-plan',
      '--recipe', 'literature_landscape',
      '--query', 'bootstrap amplitudes',
    ], io)).rejects.toThrow('cannot replace workflow plan while run_status=running; finish or reset the current run first');
  });

  it('derives a stable fallback run_id when --run-id is omitted', async () => {
    const projectRoot = makeTempProjectRoot();
    const manager = new StateManager(projectRoot);
    manager.ensureDirs();
    manager.saveState(manager.readState());
    const { io, stdout } = makeIo(projectRoot);

    const code = await runCli([
      'workflow-plan',
      '--recipe', 'literature_landscape',
      '--phase', 'prework',
      '--query', 'bootstrap amplitudes',
      '--topic', 'bootstrap amplitudes',
      '--seed-recid', '1234',
      '--preferred-provider', 'openalex',
      '--available-tool', 'openalex_search',
      '--available-tool', 'inspire_topic_analysis',
      '--available-tool', 'inspire_network_analysis',
      '--available-tool', 'inspire_trace_original_source',
    ], io);

    expect(code).toBe(0);
    expect(JSON.parse(stdout.join(''))).toMatchObject({
      recipe_id: 'literature_landscape',
      phase: 'prework',
    });
    expect(manager.readState()).toMatchObject({
      run_id: 'literature_landscape-prework',
      plan: {
        plan_id: 'literature_landscape-prework:literature_landscape',
      },
    });
  });

  it('shows JSON status for the nearest project root', async () => {
    const projectRoot = makeTempProjectRoot();
    const manager = new StateManager(projectRoot);
    manager.ensureDirs();
    const state = manager.readState() as RunState;
    state.run_id = 'M1';
    state.workflow_id = 'ingest';
    manager.saveState(state);

    const { io, stdout } = makeIo(projectRoot);
    const code = await runCli(['status', '--json'], io);

    expect(code).toBe(0);
    expect(JSON.parse(stdout.join(''))).toMatchObject({
      run_id: 'M1',
      run_status: 'idle',
      workflow_id: 'ingest',
    });
  });

  it('approves a pending gate without requiring the operator to pass a SHA', async () => {
    const { approvalId, projectRoot } = makeAwaitingApprovalState();
    const { io, stdout } = makeIo(projectRoot);

    const code = await runCli(['approve', approvalId, '--note', 'ship it'], io);

    expect(code).toBe(0);
    expect(stdout.join('')).toContain(`approved: ${approvalId}`);
    const state = new StateManager(projectRoot).readState();
    expect(state.run_status).toBe('running');
    expect(state.pending_approval).toBeNull();
    expect(state.approval_history).toHaveLength(1);
  });

  it('fails closed when run requests unsupported workflow ids', async () => {
    const projectRoot = makeTempProjectRoot();
    const manager = new StateManager(projectRoot);
    manager.ensureDirs();
    manager.saveState(manager.readState());
    const { io } = makeIo(projectRoot);
    await expect(
      runCli(['run', '--workflow-id', 'ingest', '--run-id', 'M-RUN-1'], io),
    ).rejects.toThrow('run currently supports only --workflow-id computation');
  });

  it('fails closed when run targets an uninitialized project root', async () => {
    const projectRoot = makeTempProjectRoot();
    const { io } = makeIo(projectRoot);
    await expect(
      runCli(['run', '--workflow-id', 'computation', '--run-id', 'M-RUN-UNINIT'], io),
    ).rejects.toThrow(`project root is not initialized: ${projectRoot}; run autoresearch init first`);
  });

  it('requests A3 approval when computation run is unsatisfied', async () => {
    const projectRoot = makeTempProjectRoot();
    const manager = new StateManager(projectRoot);
    manager.ensureDirs();
    manager.saveState(manager.readState());
    const runId = 'M-RUN-A3';
    const { runDir, manifestPath } = createComputationFixture(projectRoot, runId);
    const { io, stdout } = makeIo(projectRoot);

    const code = await runCli([
      'run',
      '--workflow-id', 'computation',
      '--run-id', runId,
      '--run-dir', runDir,
      '--manifest', manifestPath,
    ], io);

    expect(code).toBe(0);
    expect(JSON.parse(stdout.join(''))).toMatchObject({
      status: 'requires_approval',
      gate_id: 'A3',
      run_id: runId,
    });
    const state = manager.readState();
    expect(state.run_status).toBe('awaiting_approval');
    expect(state.pending_approval?.category).toBe('A3');
    expect(state.workflow_id).toBe('computation');
    expect(state.run_id).toBe(runId);
  });

  it('replays the same pending A3 approval when rerunning the active computation request', async () => {
    const projectRoot = makeTempProjectRoot();
    const manager = new StateManager(projectRoot);
    manager.ensureDirs();
    manager.saveState(manager.readState());
    const runId = 'M-RUN-A3-REPLAY';
    const { runDir, manifestPath } = createComputationFixture(projectRoot, runId);
    const first = makeIo(projectRoot);

    const firstCode = await runCli([
      'run',
      '--workflow-id', 'computation',
      '--run-id', runId,
      '--run-dir', runDir,
      '--manifest', manifestPath,
    ], first.io);

    expect(firstCode).toBe(0);
    const firstResult = JSON.parse(first.stdout.join(''));
    expect(firstResult).toMatchObject({
      status: 'requires_approval',
      gate_id: 'A3',
      run_id: runId,
    });

    const second = makeIo(projectRoot);
    const secondCode = await runCli([
      'run',
      '--workflow-id', 'computation',
      '--run-id', runId,
      '--run-dir', runDir,
      '--manifest', manifestPath,
    ], second.io);

    expect(secondCode).toBe(0);
    const secondResult = JSON.parse(second.stdout.join(''));
    expect(secondResult).toMatchObject({
      status: 'requires_approval',
      gate_id: 'A3',
      run_id: runId,
      approval_id: firstResult.approval_id,
      packet_path: firstResult.packet_path,
      packet_json_path: firstResult.packet_json_path,
    });
    const state = manager.readState();
    expect(state.run_status).toBe('awaiting_approval');
    expect(state.pending_approval?.approval_id).toBe(firstResult.approval_id);
    expect(state.approval_seq.A3).toBe(1);
  });

  it('clears stale gate satisfaction before starting a fresh computation run', async () => {
    const projectRoot = makeTempProjectRoot();
    const manager = new StateManager(projectRoot);
    manager.ensureDirs();
    const stale = manager.readState();
    stale.run_id = 'M-OLD';
    stale.workflow_id = 'computation';
    stale.run_status = 'completed';
    stale.gate_satisfied.A3 = 'A3-OLD';
    stale.approval_history.push({
      ts: '2026-01-01T00:00:00Z',
      approval_id: 'A3-OLD',
      category: 'A3',
      decision: 'approved',
      note: 'stale',
    });
    manager.saveState(stale);
    const runId = 'M-RUN-RESET-A3';
    const { runDir, manifestPath } = createComputationFixture(projectRoot, runId);
    const { io, stdout } = makeIo(projectRoot);

    const code = await runCli([
      'run',
      '--workflow-id', 'computation',
      '--run-id', runId,
      '--run-dir', runDir,
      '--manifest', manifestPath,
    ], io);

    expect(code).toBe(0);
    expect(JSON.parse(stdout.join(''))).toMatchObject({
      status: 'requires_approval',
      gate_id: 'A3',
      run_id: runId,
    });
    const state = manager.readState();
    expect(state.run_status).toBe('awaiting_approval');
    expect(state.gate_satisfied.A3).toBeUndefined();
    expect(state.approval_history).toHaveLength(0);
  });

  it('executes computation manifests only when A3 is satisfied for the active run', async () => {
    const projectRoot = makeTempProjectRoot();
    const manager = new StateManager(projectRoot);
    manager.ensureDirs();
    const runId = 'M-RUN-OK';
    const state = manager.readState();
    state.run_id = runId;
    state.workflow_id = 'computation';
    state.run_status = 'running';
    state.gate_satisfied.A3 = 'A3-0001';
    manager.saveState(state);
    const { runDir, manifestPath } = createComputationFixture(projectRoot, runId);
    const { io, stdout } = makeIo(projectRoot);

    const code = await runCli([
      'run',
      '--workflow-id', 'computation',
      '--run-id', runId,
      '--run-dir', runDir,
      '--manifest', manifestPath,
    ], io);

    expect(code).toBe(0);
    expect(JSON.parse(stdout.join(''))).toMatchObject({
      status: 'completed',
      ok: true,
      run_id: runId,
    });
    expect(fs.existsSync(path.join(runDir, 'computation', 'outputs', 'ok.txt'))).toBe(true);
    expect(manager.readState()).toMatchObject({
      run_id: runId,
      workflow_id: 'computation',
      run_status: 'completed',
    });
  });
});
