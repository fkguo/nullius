import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

vi.mock('@autoresearch/zotero-mcp/tooling', () => ({
  TOOL_SPECS: [],
}));
vi.mock('../../src/core/zotero/tools.js', () => ({
  hepImportFromZotero: vi.fn(),
}));

import { handleToolCall } from '../../src/tools/index.js';

let tmpDirs: string[] = [];

function makeTmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-fleet-contract-'));
  tmpDirs.push(dir);
  return dir;
}

function writeProject(projectRoot: string, opts: { completed?: boolean; invalidLedger?: boolean } = {}): void {
  const controlDir = path.join(projectRoot, '.autoresearch');
  fs.mkdirSync(controlDir, { recursive: true });
  if (!opts.invalidLedger) {
    fs.writeFileSync(path.join(controlDir, 'state.json'), JSON.stringify({
      schema_version: 1,
      run_id: opts.completed ? 'run-completed' : 'run-awaiting',
      workflow_id: 'runtime',
      run_status: opts.completed ? 'completed' : 'awaiting_approval',
      current_step: null,
      plan: null,
      plan_md_path: null,
      checkpoints: { last_checkpoint_at: null, checkpoint_interval_seconds: 900 },
      pending_approval: opts.completed ? null : {
        approval_id: 'A1-0001',
        category: 'A1',
        plan_step_ids: [],
        requested_at: '2026-03-22T00:01:00Z',
        timeout_at: null,
        on_timeout: 'block',
        packet_path: 'artifacts/runs/run-awaiting/approvals/A1-0001/packet_short.md',
      },
      approval_seq: { A1: 1, A2: 0, A3: 0, A4: 0, A5: 0 },
      gate_satisfied: {},
      approval_history: [],
      artifacts: {},
      notes: '',
    }, null, 2) + '\n', 'utf-8');
  }

  const ledgerLines = opts.invalidLedger
    ? ['{not-valid-json']
    : [JSON.stringify({
      ts: '2026-03-22T00:00:00Z',
      event_type: opts.completed ? 'status_completed' : 'approval_requested',
      run_id: opts.completed ? 'run-completed' : 'run-awaiting',
      workflow_id: 'runtime',
      step_id: null,
      details: {},
    })];
  fs.writeFileSync(path.join(controlDir, 'ledger.jsonl'), `${ledgerLines.join('\n')}\n`, 'utf-8');

  if (!opts.completed && !opts.invalidLedger) {
    const approvalDir = path.join(projectRoot, 'artifacts', 'runs', 'run-awaiting', 'approvals', 'A1-0001');
    fs.mkdirSync(approvalDir, { recursive: true });
    fs.writeFileSync(path.join(approvalDir, 'approval_packet_v1.json'), JSON.stringify({
      approval_id: 'A1-0001',
      gate_id: 'A1',
      requested_at: '2026-03-22T00:01:00Z',
    }, null, 2) + '\n', 'utf-8');
  }
}

function extractPayload(res: unknown): Record<string, unknown> {
  const result = res as { content: Array<{ text: string }> };
  return JSON.parse(result.content[0]?.text ?? '{}') as Record<string, unknown>;
}

afterEach(() => {
  for (const dir of tmpDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  tmpDirs = [];
});

describe('orch_fleet_status contract', () => {
  it('returns a read-only fleet snapshot through the host tool path', async () => {
    const goodRoot = makeTmpDir();
    const badRoot = makeTmpDir();
    writeProject(goodRoot);
    writeProject(badRoot, { invalidLedger: true });

    const res = await handleToolCall('orch_fleet_status', {
      project_roots: [goodRoot, badRoot],
    }, 'full');
    expect((res as { isError?: boolean }).isError).toBeFalsy();

    const payload = extractPayload(res);
    const summary = payload.summary as Record<string, unknown>;
    const projects = payload.projects as Array<Record<string, unknown>>;

    expect(summary.project_count).toBe(2);
    expect(summary.pending_approval_count).toBe(1);
    expect((projects[0]?.approvals as Array<Record<string, unknown>>)[0]?.status).toBe('pending');
    expect((projects[1]?.errors as Array<Record<string, unknown>>).map(item => item.code)).toEqual([
      'STATE_MISSING',
      'LEDGER_PARSE_ERROR',
    ]);
  });

  it('accepts the legacy complete alias through the host schema', async () => {
    const projectRoot = makeTmpDir();
    writeProject(projectRoot, { completed: true });

    const res = await handleToolCall('orch_fleet_status', {
      project_roots: [projectRoot],
      status_filter: 'complete',
    }, 'full');
    expect((res as { isError?: boolean }).isError).toBeFalsy();

    const payload = extractPayload(res);
    const projects = payload.projects as Array<Record<string, unknown>>;
    expect((projects[0]?.runs as Array<Record<string, unknown>>).map(item => item.last_status)).toEqual(['completed']);
  });
});
