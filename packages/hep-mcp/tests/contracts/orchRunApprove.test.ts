/**
 * Contract tests for orchestrator MCP tools (NEW-R15-impl).
 *
 * Focuses on the security-critical orch_run_approve dual-verification:
 *   1. approval_id must match pending_approval.approval_id in state
 *   2. approval_packet_sha256 must match SHA-256 of approval_packet_v1.json on disk
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createHash } from 'crypto';

vi.mock('@autoresearch/zotero-mcp/tooling', () => ({
  TOOL_SPECS: [],
}));
vi.mock('../../src/core/zotero/tools.js', () => ({
  hepImportFromZotero: vi.fn(),
}));

import { handleToolCall } from '../../src/tools/index.js';

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

let tmpDirs: string[] = [];

function makeTmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-test-'));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const d of tmpDirs) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  tmpDirs = [];
});

function setupProject(projectRoot: string, opts: {
  runId?: string;
  approvalId?: string;
  category?: string;
  packetContent?: string;
  packetSubdir?: string;
} = {}): { packetPath: string; packetSha256: string } {
  const runId = opts.runId ?? 'test-run-1';
  const approvalId = opts.approvalId ?? 'A1-0001';
  const category = opts.category ?? 'A1';

  // Create .autoresearch dir
  const arDir = path.join(projectRoot, '.autoresearch');
  fs.mkdirSync(arDir, { recursive: true });

  // Create approval packet
  const packetSubdir = opts.packetSubdir ?? `artifacts/runs/${runId}/approvals/${approvalId}`;
  const packetDir = path.join(projectRoot, packetSubdir);
  fs.mkdirSync(packetDir, { recursive: true });
  const packetContent = opts.packetContent ?? JSON.stringify({
    schema_version: 1,
    approval_id: approvalId,
    gate_id: category,
    run_id: runId,
    purpose: 'Test approval for contract tests.',
    plan: ['step 1'],
    risks: [],
    budgets: {},
    outputs: [],
    rollback: 'none',
    commands: [],
    checklist: [],
    requested_at: '2026-02-27T00:00:00Z',
  }, null, 2) + '\n';
  const jsonPacketPath = path.join(packetDir, 'approval_packet_v1.json');
  fs.writeFileSync(jsonPacketPath, packetContent, { encoding: 'utf-8' });

  const sha256 = createHash('sha256').update(Buffer.from(packetContent, 'utf-8')).digest('hex');

  // Write state.json with pending_approval
  const packetPathRel = path.join(packetSubdir, 'packet_short.md');
  const state = {
    schema_version: 1,
    run_id: runId,
    workflow_id: 'custom',
    run_status: 'awaiting_approval',
    current_step: null,
    plan: null,
    plan_md_path: null,
    checkpoints: { last_checkpoint_at: null, checkpoint_interval_seconds: 900 },
    pending_approval: {
      approval_id: approvalId,
      category,
      packet_path: packetPathRel,
      requested_at: '2026-02-27T00:00:00Z',
    },
    approval_seq: { A1: 1, A2: 0, A3: 0, A4: 0, A5: 0 },
    gate_satisfied: {},
    approval_history: [],
    artifacts: {},
    notes: '',
  };
  const stateStr = JSON.stringify(state, null, 2) + '\n';
  const statePath = path.join(arDir, 'state.json');
  const tmp = statePath + '.tmp';
  fs.writeFileSync(tmp, stateStr, { encoding: 'utf-8' });
  fs.renameSync(tmp, statePath);

  // Create empty ledger
  fs.writeFileSync(path.join(arDir, 'ledger.jsonl'), '', { encoding: 'utf-8' });

  return { packetPath: jsonPacketPath, packetSha256: sha256 };
}

function extractPayload(res: unknown): Record<string, unknown> {
  const r = res as { content: Array<{ text: string }> };
  return JSON.parse(r.content[0].text) as Record<string, unknown>;
}

function extractErrorPayload(res: unknown): { error?: { code?: string; data?: Record<string, unknown> } } {
  const r = res as { content: Array<{ text: string }> };
  return JSON.parse(r.content[0].text) as { error?: { code?: string; data?: Record<string, unknown> } };
}

// ─────────────────────────────────────────────────────────────────────────────
// orch_run_create
// ─────────────────────────────────────────────────────────────────────────────

describe('orch_run_create', () => {
  it('creates a new run and returns idle status', async () => {
    const projectRoot = makeTmpDir();
    const res = await handleToolCall(
      'orch_run_create',
      { project_root: projectRoot, run_id: 'run-abc', workflow_id: 'ingest' },
      'full',
    );
    const payload = extractPayload(res);
    expect(payload.run_id).toBe('run-abc');
    expect(payload.run_status).toBe('idle');
    expect(payload.uri).toBe('orch://runs/run-abc');
  });

  it('idempotency replay returns existing run', async () => {
    const projectRoot = makeTmpDir();
    await handleToolCall('orch_run_create', {
      project_root: projectRoot, run_id: 'run-idem', idempotency_key: 'key-1',
    }, 'full');
    const res = await handleToolCall('orch_run_create', {
      project_root: projectRoot, run_id: 'run-idem', idempotency_key: 'key-1',
    }, 'full');
    const payload = extractPayload(res);
    expect(payload.idempotency_replay).toBe(true);
    expect(payload.run_id).toBe('run-idem');
  });

  it('rejects an idempotency conflict when the existing key differs', async () => {
    const projectRoot = makeTmpDir();
    await handleToolCall('orch_run_create', {
      project_root: projectRoot, run_id: 'run-idem', idempotency_key: 'key-1',
    }, 'full');
    const res = await handleToolCall('orch_run_create', {
      project_root: projectRoot, run_id: 'run-idem', idempotency_key: 'key-2',
    }, 'full');
    expect((res as Record<string, unknown>).isError).toBe(true);
    const payload = extractErrorPayload(res);
    expect(payload.error?.code).toBe('INVALID_PARAMS');
    expect(JSON.stringify(payload)).toMatch(/idempotency_conflict/);
  });
});

describe('orch_run_list', () => {
  it('lists runs created via orch_run_create', async () => {
    const projectRoot = makeTmpDir();
    await handleToolCall(
      'orch_run_create',
      { project_root: projectRoot, run_id: 'run-list-1', workflow_id: 'ingest' },
      'full',
    );
    const res = await handleToolCall('orch_run_list', { project_root: projectRoot }, 'full');
    const payload = extractPayload(res);
    const runs = payload.runs as Array<Record<string, unknown>>;
    expect(payload.total).toBe(1);
    expect(runs.some(run => run.run_id === 'run-list-1')).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// orch_run_status
// ─────────────────────────────────────────────────────────────────────────────

describe('orch_run_status', () => {
  it('returns run status from state.json', async () => {
    const projectRoot = makeTmpDir();
    setupProject(projectRoot, { runId: 'run-status-1' });
    const res = await handleToolCall('orch_run_status', { project_root: projectRoot }, 'full');
    const payload = extractPayload(res);
    expect(payload.run_id).toBe('run-status-1');
    expect(payload.run_status).toBe('awaiting_approval');
  });

  it('returns not_found when no state exists', async () => {
    const projectRoot = makeTmpDir();
    const res = await handleToolCall('orch_run_status', { project_root: projectRoot }, 'full');
    const r = res as Record<string, unknown>;
    expect(r.isError).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// orch_run_approve — SHA-256 double verification (security-critical)
// ─────────────────────────────────────────────────────────────────────────────

describe('orch_run_approve — SHA-256 verification', () => {
  it('succeeds when approval_id and SHA-256 both match', async () => {
    const projectRoot = makeTmpDir();
    const { packetSha256 } = setupProject(projectRoot, { runId: 'run-appr-1', approvalId: 'A1-0001' });

    const res = await handleToolCall(
      'orch_run_approve',
      {
        project_root: projectRoot,
        approval_id: 'A1-0001',
        approval_packet_sha256: packetSha256,
        _confirm: true,
      },
      'full',
    );
    const payload = extractPayload(res);
    expect(payload.approved).toBe(true);
    expect(payload.approval_id).toBe('A1-0001');
    expect(payload.run_status).toBe('running');
  });

  it('rejects when SHA-256 is wrong (tampered packet)', async () => {
    const projectRoot = makeTmpDir();
    setupProject(projectRoot, { runId: 'run-tamper', approvalId: 'A1-0001' });

    const wrongSha256 = 'a'.repeat(64); // 64-char hex but wrong value
    const res = await handleToolCall(
      'orch_run_approve',
      {
        project_root: projectRoot,
        approval_id: 'A1-0001',
        approval_packet_sha256: wrongSha256,
        _confirm: true,
      },
      'full',
    );
    const r = res as Record<string, unknown>;
    expect(r.isError).toBe(true);
    const errText = JSON.stringify(r);
    expect(errText).toMatch(/sha256|mismatch|tamper/i);
  });

  it('rejects when approval_id does not match pending', async () => {
    const projectRoot = makeTmpDir();
    const { packetSha256 } = setupProject(projectRoot, { runId: 'run-wrongid', approvalId: 'A1-0001' });

    const res = await handleToolCall(
      'orch_run_approve',
      {
        project_root: projectRoot,
        approval_id: 'A1-9999',  // wrong approval_id
        approval_packet_sha256: packetSha256,
        _confirm: true,
      },
      'full',
    );
    const r = res as Record<string, unknown>;
    expect(r.isError).toBe(true);
    const errText = JSON.stringify(r);
    expect(errText).toMatch(/A1-9999|A1-0001/);
  });

  it('rejects when no pending approval exists', async () => {
    const projectRoot = makeTmpDir();
    // Create a run with NO pending approval
    await handleToolCall('orch_run_create', {
      project_root: projectRoot, run_id: 'run-nopending',
    }, 'full');

    const res = await handleToolCall(
      'orch_run_approve',
      {
        project_root: projectRoot,
        approval_id: 'A1-0001',
        approval_packet_sha256: 'a'.repeat(64),
        _confirm: true,
      },
      'full',
    );
    const r = res as Record<string, unknown>;
    expect(r.isError).toBe(true);
  });

  it('requires _confirm before approval executes', async () => {
    const projectRoot = makeTmpDir();
    const { packetSha256 } = setupProject(projectRoot, { runId: 'run-confirm', approvalId: 'A1-0001' });

    const res = await handleToolCall(
      'orch_run_approve',
      {
        project_root: projectRoot,
        approval_id: 'A1-0001',
        approval_packet_sha256: packetSha256,
      },
      'full',
    );
    expect((res as Record<string, unknown>).isError).toBe(true);
    const payload = extractErrorPayload(res);
    expect(payload.error?.code).toBe('CONFIRMATION_REQUIRED');
  });

  it('rejects when approval_packet_v1.json is missing', async () => {
    const projectRoot = makeTmpDir();
    const { packetPath, packetSha256 } = setupProject(projectRoot, { runId: 'run-missing-packet', approvalId: 'A1-0001' });
    fs.rmSync(packetPath);

    const res = await handleToolCall(
      'orch_run_approve',
      {
        project_root: projectRoot,
        approval_id: 'A1-0001',
        approval_packet_sha256: packetSha256,
        _confirm: true,
      },
      'full',
    );
    expect((res as Record<string, unknown>).isError).toBe(true);
    const payload = extractErrorPayload(res);
    expect(payload.error?.code).toBe('NOT_FOUND');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// orch_run_reject
// ─────────────────────────────────────────────────────────────────────────────

describe('orch_run_reject', () => {
  it('creates .pause file and sets status to paused', async () => {
    const projectRoot = makeTmpDir();
    setupProject(projectRoot, { runId: 'run-rej', approvalId: 'A1-0001' });

    const res = await handleToolCall(
      'orch_run_reject',
      { project_root: projectRoot, approval_id: 'A1-0001', _confirm: true, note: 'test rejection' },
      'full',
    );
    const payload = extractPayload(res);
    expect(payload.rejected).toBe(true);
    expect(payload.run_status).toBe('paused');

    // .pause file must exist
    expect(fs.existsSync(path.join(projectRoot, '.pause'))).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// orch_run_pause / orch_run_resume
// ─────────────────────────────────────────────────────────────────────────────

describe('orch_run_pause / orch_run_resume', () => {
  it('pause creates .pause, resume removes it', async () => {
    const projectRoot = makeTmpDir();
    setupProject(projectRoot, { runId: 'run-pause' });

    await handleToolCall('orch_run_pause', { project_root: projectRoot, note: 'manual pause' }, 'full');
    expect(fs.existsSync(path.join(projectRoot, '.pause'))).toBe(true);

    let statusRes = await handleToolCall('orch_run_status', { project_root: projectRoot }, 'full');
    expect(extractPayload(statusRes).is_paused).toBe(true);

    await handleToolCall('orch_run_resume', { project_root: projectRoot, note: 'resuming' }, 'full');
    expect(fs.existsSync(path.join(projectRoot, '.pause'))).toBe(false);

    statusRes = await handleToolCall('orch_run_status', { project_root: projectRoot }, 'full');
    expect(extractPayload(statusRes).is_paused).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// orch_policy_query
// ─────────────────────────────────────────────────────────────────────────────

describe('orch_policy_query', () => {
  it('returns default policy when no policy file exists', async () => {
    const projectRoot = makeTmpDir();
    const res = await handleToolCall('orch_policy_query', { project_root: projectRoot }, 'full');
    const payload = extractPayload(res);
    expect(payload.policy_exists).toBe(false);
    expect(payload.gate_to_policy_key).toBeDefined();
  });

  it('returns requires_approval for known operation', async () => {
    const projectRoot = makeTmpDir();
    const res = await handleToolCall('orch_policy_query', {
      project_root: projectRoot,
      operation: 'mass_search',
    }, 'full');
    const payload = extractPayload(res);
    expect(payload.requires_approval).toBe(true);
    expect(payload.operation).toBe('mass_search');
  });
});

describe('orch_run_export', () => {
  it('requires _confirm before export summary generation', async () => {
    const projectRoot = makeTmpDir();
    const res = await handleToolCall('orch_run_export', { project_root: projectRoot }, 'full');
    expect((res as Record<string, unknown>).isError).toBe(true);
    const payload = extractErrorPayload(res);
    expect(payload.error?.code).toBe('CONFIRMATION_REQUIRED');
    expect(payload.error?.data?.tool).toBe('orch_run_export');
  });
});

describe('orch_run_approvals_list', () => {
  it('deduplicates the current pending approval and surfaces packet sha + uri', async () => {
    const projectRoot = makeTmpDir();
    const { packetSha256 } = setupProject(projectRoot, { runId: 'run-approvals-1', approvalId: 'A1-0001' });

    const res = await handleToolCall(
      'orch_run_approvals_list',
      { project_root: projectRoot, include_history: false, gate_filter: 'all' },
      'full',
    );
    const payload = extractPayload(res);
    const approvals = payload.approvals as Array<Record<string, unknown>>;
    expect(approvals).toHaveLength(1);
    expect(approvals[0]?.approval_id).toBe('A1-0001');
    expect(approvals[0]?.approval_packet_sha256).toBe(packetSha256);
    expect(String(approvals[0]?.uri ?? '')).toContain('orch://runs/run-approvals-1/approvals/');
  });
});
