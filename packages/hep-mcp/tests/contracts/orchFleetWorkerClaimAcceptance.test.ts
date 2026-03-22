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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-fleet-worker-acceptance-contract-'));
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

afterEach(() => {
  for (const dir of tmpDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  tmpDirs = [];
});

describe('orch_fleet_worker_set_claim_acceptance host contract', () => {
  it('routes claim-acceptance updates through the shared/orchestrator host path', async () => {
    const projectRoot = makeTmpDir();
    writeProject(projectRoot);
    fs.writeFileSync(path.join(projectRoot, '.autoresearch', 'fleet_workers.json'), JSON.stringify({
      schema_version: 1,
      updated_at: '2026-03-22T00:00:00Z',
      workers: [{
        worker_id: 'worker-1',
        registered_at: '2026-03-22T00:00:00Z',
        last_heartbeat_at: '2026-03-22T00:00:00Z',
        accepts_claims: true,
        max_concurrent_claims: 1,
        heartbeat_timeout_seconds: 30,
      }],
    }, null, 2) + '\n', 'utf-8');

    const res = await handleToolCall('orch_fleet_worker_set_claim_acceptance', {
      project_root: projectRoot,
      worker_id: 'worker-1',
      accepts_claims: false,
      updated_by: 'operator',
      note: 'maintenance window',
    }, 'full');
    expect((res as { isError?: boolean }).isError).toBeFalsy();
    expect(extractPayload(res)).toMatchObject({
      updated: true,
      worker: { worker_id: 'worker-1', accepts_claims: false },
    });
    const workers = JSON.parse(fs.readFileSync(path.join(projectRoot, '.autoresearch', 'fleet_workers.json'), 'utf-8')) as { workers: Array<Record<string, unknown>> };
    expect(workers.workers[0]).toMatchObject({ worker_id: 'worker-1', accepts_claims: false });
    expect(fs.readFileSync(path.join(projectRoot, '.autoresearch', 'ledger.jsonl'), 'utf-8')).toContain('"event_type":"fleet_worker_claim_acceptance_updated"');
  });

  it('fails closed for an unknown worker', async () => {
    const projectRoot = makeTmpDir();
    writeProject(projectRoot);
    fs.writeFileSync(path.join(projectRoot, '.autoresearch', 'fleet_workers.json'), JSON.stringify({
      schema_version: 1,
      updated_at: '2026-03-22T00:00:00Z',
      workers: [],
    }, null, 2) + '\n', 'utf-8');

    const res = await handleToolCall('orch_fleet_worker_set_claim_acceptance', {
      project_root: projectRoot,
      worker_id: 'worker-missing',
      accepts_claims: false,
      updated_by: 'operator',
      note: 'maintenance window',
    }, 'full');
    expect((res as { isError?: boolean }).isError).toBe(true);
    expect(extractPayload(res).error).toMatchObject({
      code: 'INVALID_PARAMS',
      data: { worker_id: 'worker-missing', project_root: projectRoot },
    });
  });
});
