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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-fleet-worker-contract-'));
  tmpDirs.push(dir);
  return dir;
}

function writeProject(projectRoot: string, runId = 'run-1'): void {
  const controlDir = path.join(projectRoot, '.autoresearch');
  fs.mkdirSync(controlDir, { recursive: true });
  fs.writeFileSync(path.join(controlDir, 'state.json'), JSON.stringify({
    schema_version: 1,
    run_id: runId,
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
  }, null, 2) + '\n', 'utf-8');
  fs.writeFileSync(path.join(controlDir, 'ledger.jsonl'), `${JSON.stringify({
    ts: '2026-03-22T00:00:00Z',
    event_type: 'initialized',
    run_id: runId,
    workflow_id: 'runtime',
    step_id: null,
    details: {},
  })}\n`, 'utf-8');
}

function writeQueue(projectRoot: string, queue: unknown): void {
  const controlDir = path.join(projectRoot, '.autoresearch');
  fs.mkdirSync(controlDir, { recursive: true });
  fs.writeFileSync(path.join(controlDir, 'fleet_queue.json'), JSON.stringify(queue, null, 2) + '\n', 'utf-8');
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

describe('orch_fleet_worker_* host contract', () => {
  it('routes worker poll and heartbeat through the shared/orchestrator host path', async () => {
    const projectRoot = makeTmpDir();
    writeProject(projectRoot);
    writeQueue(projectRoot, {
      schema_version: 1,
      updated_at: '2026-03-22T00:00:00Z',
      items: [{ queue_item_id: 'fq_1', run_id: 'run-1', status: 'queued', priority: 3, enqueued_at: '2026-03-22T00:00:00Z', requested_by: 'operator', attempt_count: 0 }],
    });

    const poll = await handleToolCall('orch_fleet_worker_poll', {
      project_root: projectRoot,
      worker_id: 'worker-1',
      max_concurrent_claims: 1,
      heartbeat_timeout_seconds: 30,
    }, 'full');
    expect((poll as { isError?: boolean }).isError).toBeFalsy();
    expect(extractPayload(poll)).toMatchObject({
      claimed: true,
      worker: { worker_id: 'worker-1', active_claim_count: 1, available_slots: 0 },
      queue_item: { run_id: 'run-1', claim: { owner_id: 'worker-1' } },
    });

    const heartbeat = await handleToolCall('orch_fleet_worker_heartbeat', {
      project_root: projectRoot,
      worker_id: 'worker-1',
      max_concurrent_claims: 1,
      heartbeat_timeout_seconds: 30,
    }, 'full');
    expect((heartbeat as { isError?: boolean }).isError).toBeFalsy();
    expect(extractPayload(heartbeat)).toMatchObject({
      heartbeat_recorded: true,
      worker: { worker_id: 'worker-1', health_status: 'healthy' },
    });
    expect(fs.existsSync(path.join(projectRoot, '.autoresearch', 'fleet_workers.json'))).toBe(true);
  });

  it('returns deterministic non-errors for no queued item and at capacity', async () => {
    const emptyRoot = makeTmpDir();
    writeProject(emptyRoot);
    const noItem = await handleToolCall('orch_fleet_worker_poll', {
      project_root: emptyRoot,
      worker_id: 'worker-empty',
      max_concurrent_claims: 1,
      heartbeat_timeout_seconds: 30,
    }, 'full');
    expect((noItem as { isError?: boolean }).isError).toBeFalsy();
    expect(extractPayload(noItem)).toMatchObject({
      claimed: false,
      reason: 'NO_QUEUED_ITEM',
      queue_item: null,
    });

    const cappedRoot = makeTmpDir();
    writeProject(cappedRoot);
    writeQueue(cappedRoot, {
      schema_version: 1,
      updated_at: '2026-03-22T00:00:00Z',
      items: [
        {
          queue_item_id: 'fq_claimed',
          run_id: 'run-1',
          status: 'claimed',
          priority: 3,
          enqueued_at: '2026-03-22T00:00:00Z',
          requested_by: 'operator',
          attempt_count: 0,
          claim: { claim_id: 'fqc_1', owner_id: 'worker-1', claimed_at: '2026-03-22T00:00:00Z' },
        },
        { queue_item_id: 'fq_waiting', run_id: 'run-2', status: 'queued', priority: 1, enqueued_at: '2026-03-22T00:00:01Z', requested_by: 'operator', attempt_count: 0 },
      ],
    });
    const atCapacity = await handleToolCall('orch_fleet_worker_poll', {
      project_root: cappedRoot,
      worker_id: 'worker-1',
      max_concurrent_claims: 1,
      heartbeat_timeout_seconds: 30,
    }, 'full');
    expect((atCapacity as { isError?: boolean }).isError).toBeFalsy();
    expect(extractPayload(atCapacity)).toMatchObject({
      claimed: false,
      reason: 'AT_CAPACITY',
      queue_item: null,
      worker: { active_claim_count: 1, available_slots: 0 },
    });
  });

  it('fails closed for invalid worker registry payloads', async () => {
    const projectRoot = makeTmpDir();
    writeProject(projectRoot);
    fs.writeFileSync(path.join(projectRoot, '.autoresearch', 'fleet_workers.json'), '{not-valid-json\n', 'utf-8');

    const res = await handleToolCall('orch_fleet_worker_poll', {
      project_root: projectRoot,
      worker_id: 'worker-1',
      max_concurrent_claims: 1,
      heartbeat_timeout_seconds: 30,
    }, 'full');
    expect((res as { isError?: boolean }).isError).toBe(true);
    expect(extractPayload(res).error).toMatchObject({
      code: 'INVALID_PARAMS',
      data: { fleet_workers_path: path.join(projectRoot, '.autoresearch', 'fleet_workers.json') },
    });
  });
});
