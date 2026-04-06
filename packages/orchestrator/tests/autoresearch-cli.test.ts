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
    expect(stdout.join('')).toContain('autoresearch workflow-plan --recipe <recipe_id> [options]');
    expect(stdout.join('')).toContain('run/doctor/bridge remain on the transitional Pipeline A surface');
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
});
