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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-fleet-adjudicate-contract-'));
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

describe('orch_fleet_adjudicate_stale_claim host contract', () => {
  it('routes manual stale-claim adjudication through the shared/orchestrator host path', async () => {
    const projectRoot = makeTmpDir();
    writeProject(projectRoot);
    writeQueue(projectRoot, {
      schema_version: 1,
      updated_at: '2026-03-22T00:01:00Z',
      items: [{
        queue_item_id: 'fq_claimed',
        run_id: 'run-1',
        status: 'claimed',
        priority: 3,
        enqueued_at: '2026-03-22T00:00:00Z',
        requested_by: 'operator',
        attempt_count: 1,
        claim: { claim_id: 'claim-1', owner_id: 'worker-1', claimed_at: '2026-03-22T00:01:00Z' },
      }],
    });

    const res = await handleToolCall('orch_fleet_adjudicate_stale_claim', {
      project_root: projectRoot,
      queue_item_id: 'fq_claimed',
      expected_claim_id: 'claim-1',
      expected_owner_id: 'worker-1',
      adjudicated_by: 'operator-1',
      disposition: 'requeue',
      note: 'operator explicitly requeued a stale claim',
    }, 'full');
    expect((res as { isError?: boolean }).isError).toBeFalsy();
    expect(extractPayload(res)).toMatchObject({
      adjudicated: true,
      queue_item: {
        queue_item_id: 'fq_claimed',
        status: 'queued',
        attempt_count: 2,
      },
    });
    expect(JSON.parse(fs.readFileSync(path.join(projectRoot, '.autoresearch', 'fleet_queue.json'), 'utf-8')).items[0]).toMatchObject({
      status: 'queued',
      attempt_count: 2,
    });
  });

  it('fails closed for mismatched expected claim identity', async () => {
    const projectRoot = makeTmpDir();
    writeProject(projectRoot);
    writeQueue(projectRoot, {
      schema_version: 1,
      updated_at: '2026-03-22T00:01:00Z',
      items: [{
        queue_item_id: 'fq_claimed',
        run_id: 'run-1',
        status: 'claimed',
        priority: 3,
        enqueued_at: '2026-03-22T00:00:00Z',
        requested_by: 'operator',
        attempt_count: 1,
        claim: { claim_id: 'claim-2', owner_id: 'worker-2', claimed_at: '2026-03-22T00:01:00Z' },
      }],
    });

    const res = await handleToolCall('orch_fleet_adjudicate_stale_claim', {
      project_root: projectRoot,
      queue_item_id: 'fq_claimed',
      expected_claim_id: 'claim-1',
      expected_owner_id: 'worker-1',
      adjudicated_by: 'operator-1',
      disposition: 'requeue',
      note: 'operator inspected an older claim snapshot',
    }, 'full');
    expect((res as { isError?: boolean }).isError).toBe(true);
    expect(extractPayload(res).error).toMatchObject({
      code: 'INVALID_PARAMS',
      data: {
        expected_claim_id: 'claim-1',
        current_claim_id: 'claim-2',
      },
    });
  });
});
