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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-fleet-worker-unregister-contract-'));
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
    ts: '2026-03-23T00:00:00Z',
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

afterEach(() => {
  for (const dir of tmpDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  tmpDirs = [];
});

describe('orch_fleet_worker_unregister host contract', () => {
  it('routes drained worker unregister through the shared/orchestrator host path', async () => {
    const projectRoot = makeTmpDir();
    writeProject(projectRoot);
    fs.writeFileSync(path.join(projectRoot, '.autoresearch', 'fleet_workers.json'), JSON.stringify({
      schema_version: 1,
      updated_at: '2026-03-23T00:00:00Z',
      workers: [{
        worker_id: 'worker-1',
        registered_at: '2026-03-23T00:00:00Z',
        last_heartbeat_at: '2026-03-23T00:00:00Z',
        accepts_claims: false,
        max_concurrent_claims: 1,
        heartbeat_timeout_seconds: 30,
      }],
    }, null, 2) + '\n', 'utf-8');

    const res = await handleToolCall('orch_fleet_worker_unregister', {
      project_root: projectRoot,
      worker_id: 'worker-1',
      unregistered_by: 'operator',
      note: 'drain complete',
    }, 'full');

    expect((res as { isError?: boolean }).isError).toBeFalsy();
    expect(extractPayload(res)).toMatchObject({
      unregistered: true,
      worker_id: 'worker-1',
      active_claim_count: 0,
    });
    const workers = JSON.parse(fs.readFileSync(path.join(projectRoot, '.autoresearch', 'fleet_workers.json'), 'utf-8')) as { workers: Array<Record<string, unknown>> };
    expect(workers.workers).toEqual([]);
    expect(fs.readFileSync(path.join(projectRoot, '.autoresearch', 'ledger.jsonl'), 'utf-8')).toContain('"event_type":"fleet_worker_unregistered"');
  });

  it('fails closed when the worker is still accepting claims or still owns queue claims', async () => {
    const acceptingProjectRoot = makeTmpDir();
    writeProject(acceptingProjectRoot);
    fs.writeFileSync(path.join(acceptingProjectRoot, '.autoresearch', 'fleet_workers.json'), JSON.stringify({
      schema_version: 1,
      updated_at: '2026-03-23T00:00:00Z',
      workers: [{
        worker_id: 'worker-1',
        registered_at: '2026-03-23T00:00:00Z',
        last_heartbeat_at: '2026-03-23T00:00:00Z',
        accepts_claims: true,
        max_concurrent_claims: 1,
        heartbeat_timeout_seconds: 30,
      }],
    }, null, 2) + '\n', 'utf-8');

    const acceptingRes = await handleToolCall('orch_fleet_worker_unregister', {
      project_root: acceptingProjectRoot,
      worker_id: 'worker-1',
      unregistered_by: 'operator',
      note: 'drain complete',
    }, 'full');
    expect((acceptingRes as { isError?: boolean }).isError).toBe(true);
    expect(extractPayload(acceptingRes).error).toMatchObject({
      code: 'INVALID_PARAMS',
      data: { worker_id: 'worker-1', accepts_claims: true },
    });

    const activeClaimProjectRoot = makeTmpDir();
    writeProject(activeClaimProjectRoot);
    fs.writeFileSync(path.join(activeClaimProjectRoot, '.autoresearch', 'fleet_workers.json'), JSON.stringify({
      schema_version: 1,
      updated_at: '2026-03-23T00:00:00Z',
      workers: [{
        worker_id: 'worker-1',
        registered_at: '2026-03-23T00:00:00Z',
        last_heartbeat_at: '2026-03-23T00:00:00Z',
        accepts_claims: false,
        max_concurrent_claims: 1,
        heartbeat_timeout_seconds: 30,
      }],
    }, null, 2) + '\n', 'utf-8');
    fs.writeFileSync(path.join(activeClaimProjectRoot, '.autoresearch', 'fleet_queue.json'), JSON.stringify({
      schema_version: 1,
      updated_at: '2026-03-23T00:00:00Z',
      items: [{
        queue_item_id: 'fq_claimed',
        run_id: 'run-1',
        status: 'claimed',
        priority: 1,
        enqueued_at: '2026-03-23T00:00:00Z',
        requested_by: 'operator',
        attempt_count: 0,
        claim: {
          claim_id: 'claim-1',
          owner_id: 'worker-1',
          claimed_at: '2026-03-23T00:00:00Z',
          lease_duration_seconds: 60,
          lease_expires_at: '2026-03-23T00:01:00Z',
        },
      }],
    }, null, 2) + '\n', 'utf-8');

    const activeClaimRes = await handleToolCall('orch_fleet_worker_unregister', {
      project_root: activeClaimProjectRoot,
      worker_id: 'worker-1',
      unregistered_by: 'operator',
      note: 'drain complete',
    }, 'full');
    expect((activeClaimRes as { isError?: boolean }).isError).toBe(true);
    expect(extractPayload(activeClaimRes).error).toMatchObject({
      code: 'INVALID_PARAMS',
      data: { worker_id: 'worker-1', active_claim_count: 1 },
    });
  });
});
