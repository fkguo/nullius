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

function buildLeaseClaim(overrides: {
  claim_id?: string;
  owner_id?: string;
  claimed_at?: string;
  lease_duration_seconds?: number;
  lease_expires_at?: string;
} = {}): Record<string, unknown> {
  const claimedAt = overrides.claimed_at ?? '2026-03-22T00:00:00Z';
  const leaseDurationSeconds = overrides.lease_duration_seconds ?? 60;
  const leaseExpiresAt = overrides.lease_expires_at
    ?? new Date(Date.parse(claimedAt) + (leaseDurationSeconds * 1000)).toISOString().replace(/\.\d{3}Z$/, 'Z');
  return {
    claim_id: overrides.claim_id ?? 'claim-1',
    owner_id: overrides.owner_id ?? 'worker-1',
    claimed_at: claimedAt,
    lease_duration_seconds: leaseDurationSeconds,
    lease_expires_at: leaseExpiresAt,
  };
}

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

function writeQueue(projectRoot: string, content: unknown): void {
  const controlDir = path.join(projectRoot, '.autoresearch');
  fs.mkdirSync(controlDir, { recursive: true });
  const payload = typeof content === 'string' ? content : JSON.stringify(content, null, 2) + '\n';
  fs.writeFileSync(path.join(controlDir, 'fleet_queue.json'), payload, 'utf-8');
}

function writeWorkers(projectRoot: string, content: unknown): void {
  const controlDir = path.join(projectRoot, '.autoresearch');
  fs.mkdirSync(controlDir, { recursive: true });
  const payload = typeof content === 'string' ? content : JSON.stringify(content, null, 2) + '\n';
  fs.writeFileSync(path.join(controlDir, 'fleet_workers.json'), payload, 'utf-8');
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
    writeQueue(goodRoot, {
      schema_version: 1,
      updated_at: '2026-03-22T00:02:00Z',
      items: [{
        queue_item_id: 'fq_001',
        run_id: 'run-awaiting',
        status: 'queued',
        priority: 3,
        enqueued_at: '2026-03-22T00:01:30Z',
        requested_by: 'operator',
        attempt_count: 0,
      }],
    });
    writeQueue(badRoot, '{not-valid-json\n');

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
    expect((projects[0]?.queue as Record<string, unknown>).queue_initialized).toBe(true);
    expect(((projects[0]?.queue as Record<string, unknown>).by_status as Record<string, number>).queued).toBe(1);
    expect((projects[1]?.errors as Array<Record<string, unknown>>).map(item => item.code)).toEqual([
      'STATE_MISSING',
      'LEDGER_PARSE_ERROR',
      'FLEET_QUEUE_PARSE_ERROR',
    ]);
  });

  it('rejects the retired complete alias through the host schema and requires completed', async () => {
    const projectRoot = makeTmpDir();
    writeProject(projectRoot, { completed: true });

    const invalid = await handleToolCall('orch_fleet_status', {
      project_roots: [projectRoot],
      status_filter: 'complete',
    }, 'full');
    expect((invalid as { isError?: boolean }).isError).toBe(true);

    const res = await handleToolCall('orch_fleet_status', {
      project_roots: [projectRoot],
      status_filter: 'completed',
    }, 'full');
    expect((res as { isError?: boolean }).isError).toBeFalsy();

    const payload = extractPayload(res);
    const projects = payload.projects as Array<Record<string, unknown>>;
    expect((projects[0]?.runs as Array<Record<string, unknown>>).map(item => item.last_status)).toEqual(['completed']);
    expect((projects[0]?.queue as Record<string, unknown>).queue_initialized).toBe(false);
  });

  it('returns operator stale-signal diagnostics through the host tool path', async () => {
    const projectRoot = makeTmpDir();
    writeProject(projectRoot);
    writeQueue(projectRoot, {
      schema_version: 1,
      updated_at: '2026-03-22T00:02:00Z',
      items: [{
        queue_item_id: 'fq_001',
        run_id: 'run-awaiting',
        status: 'claimed',
        priority: 3,
        enqueued_at: '2026-03-22T00:01:30Z',
        requested_by: 'operator',
        attempt_count: 0,
        claim: buildLeaseClaim({ claim_id: 'fqc_001', owner_id: 'worker-stale', claimed_at: '2026-03-22T00:01:40Z', lease_duration_seconds: 15 }),
      }],
    });
    writeWorkers(projectRoot, {
      schema_version: 1,
      updated_at: '2026-03-22T00:02:05Z',
      workers: [{
        worker_id: 'worker-stale',
        registered_at: '2026-03-22T00:00:00Z',
        last_heartbeat_at: '2026-03-22T00:00:00Z',
        accepts_claims: false,
        max_concurrent_claims: 1,
        heartbeat_timeout_seconds: 5,
      }],
    });

    const res = await handleToolCall('orch_fleet_status', {
      project_roots: [projectRoot],
    }, 'full');
    expect((res as { isError?: boolean }).isError).toBeFalsy();

    const payload = extractPayload(res);
    const summary = payload.summary as Record<string, unknown>;
    const queue = ((payload.projects as Array<Record<string, unknown>>)[0]?.queue ?? {}) as Record<string, unknown>;
    const item = ((queue.items as Array<Record<string, unknown>>) ?? [])[0] ?? {};

    expect(summary.attention_claim_count).toBe(1);
    expect(summary.claimed_with_stale_worker_count).toBe(1);
    expect(summary.expired_claim_count).toBe(1);
    expect(summary.accepting_worker_count).toBe(0);
    expect(summary.not_accepting_worker_count).toBe(1);
    expect(queue.attention_claim_count).toBe(1);
    expect(queue.claimed_with_stale_worker_count).toBe(1);
    expect(queue.expired_claim_count).toBe(1);
    expect(item.owner_worker_health).toBe('stale');
    expect(item.attention_required).toBe(true);
    expect(item.attention_reasons).toEqual(['OWNER_WORKER_STALE']);
    expect(item.lease_expired).toBe(true);
    expect(item.lease_duration_seconds).toBeUndefined();
    expect(typeof item.claim_age_seconds).toBe('number');
    expect(typeof item.last_heartbeat_age_seconds).toBe('number');
    expect(typeof item.lease_expires_at).toBe('string');
    expect((((payload.projects as Array<Record<string, unknown>>)[0]?.workers as Record<string, unknown>).workers as Array<Record<string, unknown>>)[0]?.accepts_claims).toBe(false);
  });
});
