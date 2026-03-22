import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { RunState } from '../src/index.js';
import { handleOrchFleetStatus } from '../src/orch-tools/fleet-status.js';
import { OrchFleetStatusSchema } from '../src/orch-tools/schemas.js';

let tmpDirs: string[] = [];

function makeTmpDir(parent = os.tmpdir()): string {
  const dir = fs.mkdtempSync(path.join(parent, 'orch-fleet-'));
  tmpDirs.push(dir);
  return dir;
}

function baseState(overrides: Partial<RunState> = {}): RunState {
  return {
    schema_version: 1,
    run_id: 'run-1',
    workflow_id: 'runtime',
    run_status: 'idle',
    current_step: null,
    plan: null,
    plan_md_path: null,
    checkpoints: { last_checkpoint_at: null, checkpoint_interval_seconds: 900 },
    pending_approval: null,
    approval_seq: { A1: 0, A2: 0, A3: 0, A4: 0, A5: 0 },
    gate_satisfied: {},
    approval_history: [],
    artifacts: {},
    notes: '',
    ...overrides,
  };
}

function writeState(projectRoot: string, state: RunState): void {
  const controlDir = path.join(projectRoot, '.autoresearch');
  fs.mkdirSync(controlDir, { recursive: true });
  fs.writeFileSync(path.join(controlDir, 'state.json'), JSON.stringify(state, null, 2) + '\n', 'utf-8');
}

function writeLedger(projectRoot: string, events: Array<Record<string, unknown> | string>): void {
  const controlDir = path.join(projectRoot, '.autoresearch');
  fs.mkdirSync(controlDir, { recursive: true });
  const content = events
    .map(event => typeof event === 'string' ? event : JSON.stringify(event))
    .join('\n');
  fs.writeFileSync(path.join(controlDir, 'ledger.jsonl'), `${content}\n`, 'utf-8');
}

function writeApprovalPacket(projectRoot: string, runId: string, approvalId: string): void {
  const approvalDir = path.join(projectRoot, 'artifacts', 'runs', runId, 'approvals', approvalId);
  fs.mkdirSync(approvalDir, { recursive: true });
  fs.writeFileSync(path.join(approvalDir, 'approval_packet_v1.json'), JSON.stringify({
    approval_id: approvalId,
    gate_id: 'A1',
    requested_at: '2026-03-22T00:01:00Z',
  }, null, 2) + '\n', 'utf-8');
}

afterEach(() => {
  for (const dir of tmpDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  tmpDirs = [];
});

describe('orch_fleet_status', () => {
  it('aggregates deduped project roots with current-run approval visibility', async () => {
    const homeProjectRoot = makeTmpDir(os.homedir());
    const approvalId = 'A1-0001';
    writeState(homeProjectRoot, baseState({
      run_id: 'run-awaiting',
      run_status: 'awaiting_approval',
      pending_approval: {
        approval_id: approvalId,
        category: 'A1',
        plan_step_ids: [],
        requested_at: '2026-03-22T00:01:00Z',
        timeout_at: null,
        on_timeout: 'block',
        packet_path: `artifacts/runs/run-awaiting/approvals/${approvalId}/packet_short.md`,
      },
    }));
    writeLedger(homeProjectRoot, [
      {
        ts: '2026-03-22T00:00:00Z',
        event_type: 'initialized',
        run_id: 'run-awaiting',
        workflow_id: 'runtime',
        step_id: null,
        details: {},
      },
      {
        ts: '2026-03-22T00:01:00Z',
        event_type: 'approval_requested',
        run_id: 'run-awaiting',
        workflow_id: 'runtime',
        step_id: null,
        details: { approval_id: approvalId, category: 'A1' },
      },
    ]);
    writeApprovalPacket(homeProjectRoot, 'run-awaiting', approvalId);

    const tildeRoot = `~/${path.basename(homeProjectRoot)}`;
    const payload = await handleOrchFleetStatus(OrchFleetStatusSchema.parse({
      project_roots: [tildeRoot, homeProjectRoot],
    })) as {
      summary: { project_count: number; run_count: number; pending_approval_count: number; by_status: Record<string, number> };
      projects: Array<{ approvals: Array<Record<string, unknown>>; current_run: Record<string, unknown> | null; errors: unknown[] }>;
    };

    expect(payload.summary.project_count).toBe(1);
    expect(payload.summary.run_count).toBe(1);
    expect(payload.summary.pending_approval_count).toBe(1);
    expect(payload.summary.by_status.awaiting_approval).toBe(1);
    expect(payload.projects[0]?.errors).toEqual([]);
    expect(payload.projects[0]?.current_run?.run_id).toBe('run-awaiting');
    expect(payload.projects[0]?.approvals[0]?.status).toBe('pending');
  });

  it('keeps per-project file problems inside errors[] instead of failing the whole snapshot', async () => {
    const projectRoot = makeTmpDir();
    writeLedger(projectRoot, ['{not-valid-json']);

    const payload = await handleOrchFleetStatus(OrchFleetStatusSchema.parse({
      project_roots: [projectRoot],
    })) as {
      summary: { error_count: number };
      projects: Array<{ errors: Array<{ code: string }> }>;
    };

    expect(payload.summary.error_count).toBe(2);
    expect(payload.projects[0]?.errors.map(item => item.code)).toEqual(['STATE_MISSING', 'LEDGER_PARSE_ERROR']);
  });

  it('accepts the legacy complete alias but filters on completed status', async () => {
    const projectRoot = makeTmpDir();
    writeState(projectRoot, baseState({
      run_id: 'run-completed',
      run_status: 'completed',
    }));
    writeLedger(projectRoot, [
      {
        ts: '2026-03-22T00:00:00Z',
        event_type: 'status_completed',
        run_id: 'run-completed',
        workflow_id: 'runtime',
        step_id: null,
        details: {},
      },
      {
        ts: '2026-03-22T00:01:00Z',
        event_type: 'status_failed',
        run_id: 'run-failed',
        workflow_id: 'runtime',
        step_id: null,
        details: {},
      },
    ]);

    const payload = await handleOrchFleetStatus(OrchFleetStatusSchema.parse({
      project_roots: [projectRoot],
      status_filter: 'complete',
    })) as {
      projects: Array<{ runs: Array<{ run_id: string; last_status: string }> }>;
    };

    expect(payload.projects[0]?.runs).toEqual([
      { run_id: 'run-completed', last_event: 'status_completed', last_status: 'completed', timestamp_utc: '2026-03-22T00:00:00Z', uri: 'orch://runs/run-completed' },
    ]);
  });

  it('surfaces unmapped ledger events instead of silently hiding the status fallback', async () => {
    const projectRoot = makeTmpDir();
    writeState(projectRoot, baseState({
      run_id: 'run-unknown',
      run_status: 'idle',
    }));
    writeLedger(projectRoot, [
      {
        ts: '2026-03-22T00:00:00Z',
        event_type: 'custom_operator_note',
        run_id: 'run-unknown',
        workflow_id: 'runtime',
        step_id: null,
        details: {},
      },
    ]);

    const payload = await handleOrchFleetStatus(OrchFleetStatusSchema.parse({
      project_roots: [projectRoot],
    })) as {
      projects: Array<{ runs: Array<{ last_status: string }>; errors: Array<{ code: string; message: string }> }>;
    };

    expect(payload.projects[0]?.runs[0]?.last_status).toBe('unknown');
    expect(payload.projects[0]?.errors.map(item => item.code)).toContain('LEDGER_EVENT_UNMAPPED');
    expect(payload.projects[0]?.errors.find(item => item.code === 'LEDGER_EVENT_UNMAPPED')?.message).toContain('custom_operator_note x1');
  });
});
