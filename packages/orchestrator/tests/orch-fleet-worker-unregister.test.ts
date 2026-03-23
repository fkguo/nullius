import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { handleOrchFleetWorkerUnregister } from '../src/orch-tools/fleet-worker-unregister.js';
import { readFleetWorkers } from '../src/orch-tools/fleet-worker-store.js';
import { OrchFleetWorkerUnregisterSchema } from '../src/orch-tools/schemas.js';
import {
  buildLeaseClaim,
  cleanupTmpDirs,
  makeTmpDir,
  writeQueue,
  writeWorkers,
} from './orchFleetTestSupport.js';
import {
  fleetWorker,
  unregisterPayload,
  writeInitializedProject,
} from './orchFleetWorkerUnregisterSupport.js';

afterEach(() => {
  cleanupTmpDirs();
});

describe('orch_fleet_worker_unregister', () => {
  it('removes a drained worker from fleet_workers.json without mutating fleet_queue.json', async () => {
    const projectRoot = makeTmpDir();
    writeInitializedProject(projectRoot);
    writeQueue(projectRoot, {
      schema_version: 1,
      updated_at: '2026-03-23T00:00:00Z',
      items: [
        {
          queue_item_id: 'fq_other',
          run_id: 'run-2',
          status: 'claimed',
          priority: 1,
          enqueued_at: '2026-03-23T00:00:00Z',
          requested_by: 'operator',
          attempt_count: 0,
          claim: buildLeaseClaim({ claim_id: 'claim-other', owner_id: 'worker-2' }),
        },
        {
          queue_item_id: 'fq_waiting',
          run_id: 'run-3',
          status: 'queued',
          priority: 2,
          enqueued_at: '2026-03-23T00:00:01Z',
          requested_by: 'operator',
          attempt_count: 0,
        },
      ],
    });
    const queueBefore = fs.readFileSync(path.join(projectRoot, '.autoresearch', 'fleet_queue.json'), 'utf-8');
    writeWorkers(projectRoot, {
      schema_version: 1,
      updated_at: '2026-03-23T00:00:00Z',
      workers: [
        fleetWorker({ max_concurrent_claims: 2, note: 'drained worker' }),
        fleetWorker({ worker_id: 'worker-2', accepts_claims: true }),
      ],
    });

    const payload = await handleOrchFleetWorkerUnregister(OrchFleetWorkerUnregisterSchema.parse(
      unregisterPayload(projectRoot),
    )) as {
      unregistered: boolean;
      worker_id: string;
      active_claim_count: number;
    };

    expect(payload).toMatchObject({
      unregistered: true,
      worker_id: 'worker-1',
      active_claim_count: 0,
    });
    expect(readFleetWorkers(projectRoot).registry?.workers.map(worker => worker.worker_id)).toEqual(['worker-2']);
    expect(fs.readFileSync(path.join(projectRoot, '.autoresearch', 'fleet_queue.json'), 'utf-8')).toBe(queueBefore);
    const ledger = fs.readFileSync(path.join(projectRoot, '.autoresearch', 'ledger.jsonl'), 'utf-8');
    expect(ledger).toContain('"event_type":"fleet_worker_unregistered"');
    expect(ledger).toContain('"worker_id":"worker-1"');
    expect(ledger).toContain('"unregistered_by":"operator"');
  });

  it('treats a missing queue registry as zero active claims instead of inventing a second authority', async () => {
    const projectRoot = makeTmpDir();
    writeInitializedProject(projectRoot);
    writeWorkers(projectRoot, {
      schema_version: 1,
      updated_at: '2026-03-23T00:00:00Z',
      workers: [fleetWorker()],
    });

    const payload = await handleOrchFleetWorkerUnregister(OrchFleetWorkerUnregisterSchema.parse(
      unregisterPayload(projectRoot, { note: 'worker retired from this root' }),
    )) as { unregistered: boolean };

    expect(payload.unregistered).toBe(true);
    expect(readFleetWorkers(projectRoot).registry?.workers).toEqual([]);
    expect(fs.existsSync(path.join(projectRoot, '.autoresearch', 'fleet_queue.json'))).toBe(false);
  });

  it('fails closed for unknown workers, open claim acceptance, active claims, or invalid registries', async () => {
    const missingWorkerProjectRoot = makeTmpDir();
    writeInitializedProject(missingWorkerProjectRoot);
    writeWorkers(missingWorkerProjectRoot, {
      schema_version: 1,
      updated_at: '2026-03-23T00:00:00Z',
      workers: [],
    });
    await expect(handleOrchFleetWorkerUnregister(OrchFleetWorkerUnregisterSchema.parse(
      unregisterPayload(missingWorkerProjectRoot, { worker_id: 'worker-missing' }),
    ))).rejects.toMatchObject({
      code: 'INVALID_PARAMS',
      data: { worker_id: 'worker-missing', project_root: missingWorkerProjectRoot },
    });

    const acceptingProjectRoot = makeTmpDir();
    writeInitializedProject(acceptingProjectRoot);
    writeWorkers(acceptingProjectRoot, {
      schema_version: 1,
      updated_at: '2026-03-23T00:00:00Z',
      workers: [fleetWorker({ accepts_claims: true })],
    });
    await expect(handleOrchFleetWorkerUnregister(OrchFleetWorkerUnregisterSchema.parse(
      unregisterPayload(acceptingProjectRoot),
    ))).rejects.toMatchObject({
      code: 'INVALID_PARAMS',
      data: { worker_id: 'worker-1', accepts_claims: true },
    });

    const activeClaimProjectRoot = makeTmpDir();
    writeInitializedProject(activeClaimProjectRoot);
    writeQueue(activeClaimProjectRoot, {
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
        claim: buildLeaseClaim({ claim_id: 'claim-1', owner_id: 'worker-1' }),
      }],
    });
    writeWorkers(activeClaimProjectRoot, {
      schema_version: 1,
      updated_at: '2026-03-23T00:00:00Z',
      workers: [fleetWorker()],
    });
    await expect(handleOrchFleetWorkerUnregister(OrchFleetWorkerUnregisterSchema.parse(
      unregisterPayload(activeClaimProjectRoot),
    ))).rejects.toMatchObject({
      code: 'INVALID_PARAMS',
      data: { worker_id: 'worker-1', active_claim_count: 1 },
    });

    const invalidRegistryProjectRoot = makeTmpDir();
    writeInitializedProject(invalidRegistryProjectRoot);
    writeWorkers(invalidRegistryProjectRoot, '{not-valid-json\n');
    await expect(handleOrchFleetWorkerUnregister(OrchFleetWorkerUnregisterSchema.parse(
      unregisterPayload(invalidRegistryProjectRoot),
    ))).rejects.toMatchObject({
      code: 'INVALID_PARAMS',
      data: { fleet_workers_path: path.join(invalidRegistryProjectRoot, '.autoresearch', 'fleet_workers.json') },
    });

    const invalidQueueProjectRoot = makeTmpDir();
    writeInitializedProject(invalidQueueProjectRoot);
    writeQueue(invalidQueueProjectRoot, '{not-valid-json\n');
    writeWorkers(invalidQueueProjectRoot, {
      schema_version: 1,
      updated_at: '2026-03-23T00:00:00Z',
      workers: [fleetWorker()],
    });
    await expect(handleOrchFleetWorkerUnregister(OrchFleetWorkerUnregisterSchema.parse(
      unregisterPayload(invalidQueueProjectRoot),
    ))).rejects.toMatchObject({
      code: 'INVALID_PARAMS',
      data: { fleet_queue_path: path.join(invalidQueueProjectRoot, '.autoresearch', 'fleet_queue.json') },
    });
  });
});
