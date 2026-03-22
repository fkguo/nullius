import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { readFleetWorkers } from '../src/orch-tools/fleet-worker-store.js';
import { handleOrchFleetWorkerSetClaimAcceptance } from '../src/orch-tools/fleet-worker-claim-acceptance.js';
import { OrchFleetWorkerSetClaimAcceptanceSchema } from '../src/orch-tools/schemas.js';
import {
  baseState,
  cleanupTmpDirs,
  makeTmpDir,
  writeLedger,
  writeQueue,
  writeState,
  writeWorkers,
} from './orchFleetTestSupport.js';

function writeProject(projectRoot: string, runId = 'run-1'): void {
  writeState(projectRoot, baseState({ run_id: runId }));
  writeLedger(projectRoot, [{
    ts: '2026-03-22T00:00:00Z',
    event_type: 'initialized',
    run_id: runId,
    workflow_id: 'runtime',
    step_id: null,
    details: {},
  }]);
}

afterEach(() => {
  cleanupTmpDirs();
});

describe('orch_fleet_worker_set_claim_acceptance', () => {
  it('updates an existing worker gate without mutating queue ownership', async () => {
    const projectRoot = makeTmpDir();
    writeProject(projectRoot);
    writeQueue(projectRoot, {
      schema_version: 1,
      updated_at: '2026-03-22T00:00:00Z',
      items: [{
        queue_item_id: 'fq_1',
        run_id: 'run-1',
        status: 'queued',
        priority: 1,
        enqueued_at: '2026-03-22T00:00:00Z',
        requested_by: 'operator',
        attempt_count: 0,
      }],
    });
    writeWorkers(projectRoot, {
      schema_version: 1,
      updated_at: '2026-03-22T00:00:00Z',
      workers: [{
        worker_id: 'worker-1',
        registered_at: '2026-03-22T00:00:00Z',
        last_heartbeat_at: '2026-03-22T00:00:00Z',
        accepts_claims: true,
        max_concurrent_claims: 2,
        heartbeat_timeout_seconds: 30,
        note: 'steady state',
      }],
    });

    const payload = await handleOrchFleetWorkerSetClaimAcceptance(OrchFleetWorkerSetClaimAcceptanceSchema.parse({
      project_root: projectRoot,
      worker_id: 'worker-1',
      accepts_claims: false,
      updated_by: 'operator',
      note: 'maintenance window',
    })) as { updated: boolean; worker: { worker_id: string; accepts_claims: boolean; note?: string } };

    expect(payload).toMatchObject({
      updated: true,
      worker: { worker_id: 'worker-1', accepts_claims: false, note: 'steady state' },
    });
    expect(readFleetWorkers(projectRoot).registry?.workers[0]).toMatchObject({
      worker_id: 'worker-1',
      accepts_claims: false,
      note: 'steady state',
    });
    const queue = JSON.parse(fs.readFileSync(path.join(projectRoot, '.autoresearch', 'fleet_queue.json'), 'utf-8')) as { items: Array<{ status: string }> };
    expect(queue.items[0]?.status).toBe('queued');
    const ledger = fs.readFileSync(path.join(projectRoot, '.autoresearch', 'ledger.jsonl'), 'utf-8');
    expect(ledger).toContain('"event_type":"fleet_worker_claim_acceptance_updated"');
    expect(ledger).toContain('"updated_by":"operator"');
    expect(ledger).toContain('"accepts_claims":false');
  });

  it('fails closed when the worker is unknown or the registry is invalid', async () => {
    const missingWorkerProjectRoot = makeTmpDir();
    writeProject(missingWorkerProjectRoot);
    writeWorkers(missingWorkerProjectRoot, {
      schema_version: 1,
      updated_at: '2026-03-22T00:00:00Z',
      workers: [],
    });

    await expect(handleOrchFleetWorkerSetClaimAcceptance(OrchFleetWorkerSetClaimAcceptanceSchema.parse({
      project_root: missingWorkerProjectRoot,
      worker_id: 'worker-missing',
      accepts_claims: false,
      updated_by: 'operator',
      note: 'maintenance window',
    }))).rejects.toMatchObject({
      code: 'INVALID_PARAMS',
      data: { worker_id: 'worker-missing', project_root: missingWorkerProjectRoot },
    });

    const invalidRegistryProjectRoot = makeTmpDir();
    writeProject(invalidRegistryProjectRoot);
    writeWorkers(invalidRegistryProjectRoot, '{not-valid-json\n');
    await expect(handleOrchFleetWorkerSetClaimAcceptance(OrchFleetWorkerSetClaimAcceptanceSchema.parse({
      project_root: invalidRegistryProjectRoot,
      worker_id: 'worker-1',
      accepts_claims: false,
      updated_by: 'operator',
      note: 'maintenance window',
    }))).rejects.toMatchObject({
      code: 'INVALID_PARAMS',
      data: { fleet_workers_path: path.join(invalidRegistryProjectRoot, '.autoresearch', 'fleet_workers.json') },
    });
  });
});
