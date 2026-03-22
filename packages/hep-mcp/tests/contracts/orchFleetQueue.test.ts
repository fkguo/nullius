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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-fleet-queue-contract-'));
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

function extractPayload(res: unknown): Record<string, unknown> {
  const result = res as { content: Array<{ text: string }> };
  return JSON.parse(result.content[0]?.text ?? '{}') as Record<string, unknown>;
}

function readQueue(projectRoot: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(projectRoot, '.autoresearch', 'fleet_queue.json'), 'utf-8')) as Record<string, unknown>;
}

afterEach(() => {
  for (const dir of tmpDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  tmpDirs = [];
});

describe('orch_fleet_queue host contract', () => {
  it('routes enqueue, claim, and release through the shared/orchestrator host path', async () => {
    const projectRoot = makeTmpDir();
    writeProject(projectRoot);

    const enqueue = await handleToolCall('orch_fleet_enqueue', {
      project_root: projectRoot,
      run_id: 'run-1',
      requested_by: 'operator',
      priority: 9,
    }, 'full');
    expect((enqueue as { isError?: boolean }).isError).toBeFalsy();

    const claim = await handleToolCall('orch_fleet_claim', {
      project_root: projectRoot,
      owner_id: 'worker-1',
    }, 'full');
    expect((claim as { isError?: boolean }).isError).toBeFalsy();

    const claimedPayload = extractPayload(claim) as {
      queue_item: { queue_item_id: string; run_id: string; claim?: { lease_duration_seconds: number; lease_expires_at: string } };
    };
    expect(claimedPayload.queue_item.run_id).toBe('run-1');
    expect(claimedPayload.queue_item.claim).toMatchObject({ lease_duration_seconds: 60 });

    const release = await handleToolCall('orch_fleet_release', {
      project_root: projectRoot,
      queue_item_id: claimedPayload.queue_item.queue_item_id,
      owner_id: 'worker-1',
      disposition: 'completed',
    }, 'full');
    expect((release as { isError?: boolean }).isError).toBeFalsy();

    const releasedPayload = extractPayload(release) as {
      released: boolean;
      queue_item: { status: string; claim?: unknown };
    };
    expect(releasedPayload.released).toBe(true);
    expect(releasedPayload.queue_item.status).toBe('completed');
    expect(releasedPayload.queue_item.claim).toBeUndefined();
    expect((readQueue(projectRoot).items as Array<Record<string, unknown>>)[0]?.status).toBe('completed');
    expect(fs.readFileSync(path.join(projectRoot, '.autoresearch', 'ledger.jsonl'), 'utf-8')).toContain('"lease_duration_seconds":60');
  });

  it('returns a deterministic non-error when no queued item exists', async () => {
    const projectRoot = makeTmpDir();
    writeProject(projectRoot);

    const res = await handleToolCall('orch_fleet_claim', {
      project_root: projectRoot,
      owner_id: 'worker-1',
    }, 'full');
    expect((res as { isError?: boolean }).isError).toBeFalsy();

    expect(extractPayload(res)).toEqual({
      claimed: false,
      project_root: projectRoot,
      reason: 'NO_QUEUED_ITEM',
      diagnostic: 'no queued fleet item is available to claim',
      queue_item: null,
    });
  });

  it('fails closed for unknown runs and owner mismatches', async () => {
    const projectRoot = makeTmpDir();
    writeProject(projectRoot);

    const enqueueError = await handleToolCall('orch_fleet_enqueue', {
      project_root: projectRoot,
      run_id: 'run-missing',
      requested_by: 'operator',
    }, 'full');
    expect((enqueueError as { isError?: boolean }).isError).toBe(true);
    expect(extractPayload(enqueueError).error).toMatchObject({
      code: 'INVALID_PARAMS',
      data: { run_id: 'run-missing', project_root: projectRoot },
    });

    const enqueue = await handleToolCall('orch_fleet_enqueue', {
      project_root: projectRoot,
      run_id: 'run-1',
      requested_by: 'operator',
    }, 'full');
    const queueItemId = ((extractPayload(await handleToolCall('orch_fleet_claim', {
      project_root: projectRoot,
      owner_id: 'worker-1',
    }, 'full')) as { queue_item: { queue_item_id: string } }).queue_item.queue_item_id);

    expect((enqueue as { isError?: boolean }).isError).toBeFalsy();
    const releaseError = await handleToolCall('orch_fleet_release', {
      project_root: projectRoot,
      queue_item_id: queueItemId,
      owner_id: 'worker-9',
      disposition: 'completed',
    }, 'full');
    expect((releaseError as { isError?: boolean }).isError).toBe(true);
    expect(extractPayload(releaseError).error).toMatchObject({
      code: 'INVALID_PARAMS',
      data: { queue_item_id: queueItemId, owner_id: 'worker-9', current_owner_id: 'worker-1' },
    });
  });
});
