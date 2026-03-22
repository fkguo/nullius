import { afterEach, describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { readFleetWorkers } from '../src/orch-tools/fleet-worker-store.js';
import { handleOrchFleetWorkerHeartbeat } from '../src/orch-tools/fleet-worker-tools.js';
import { OrchFleetWorkerHeartbeatSchema } from '../src/orch-tools/schemas.js';
import { cleanupTmpDirs, makeTmpDir, writeWorkers } from './orchFleetTestSupport.js';

afterEach(() => {
  cleanupTmpDirs();
});

describe('orch_fleet_worker_heartbeat', () => {
  it('registers or refreshes worker liveness without touching queue ownership', async () => {
    const projectRoot = makeTmpDir();

    const first = await handleOrchFleetWorkerHeartbeat(OrchFleetWorkerHeartbeatSchema.parse({
      project_root: projectRoot,
      worker_id: 'worker-1',
      max_concurrent_claims: 2,
      heartbeat_timeout_seconds: 45,
      note: 'baseline worker',
    })) as { heartbeat_recorded: boolean; worker: { worker_id: string; health_status: string; note?: string } };

    expect(first).toMatchObject({
      heartbeat_recorded: true,
      worker: { worker_id: 'worker-1', health_status: 'healthy', note: 'baseline worker', accepts_claims: true },
    });

    const firstWorkers = readFleetWorkers(projectRoot).registry;
    expect(firstWorkers?.workers[0]).toMatchObject({
      worker_id: 'worker-1',
      max_concurrent_claims: 2,
      heartbeat_timeout_seconds: 45,
      accepts_claims: true,
      note: 'baseline worker',
    });
    const registeredAt = firstWorkers?.workers[0]?.registered_at;

    const second = await handleOrchFleetWorkerHeartbeat(OrchFleetWorkerHeartbeatSchema.parse({
      project_root: projectRoot,
      worker_id: 'worker-1',
      max_concurrent_claims: 3,
      heartbeat_timeout_seconds: 60,
    })) as { heartbeat_recorded: boolean; worker: { worker_id: string; health_status: string } };

    expect(second).toMatchObject({
      heartbeat_recorded: true,
      worker: { worker_id: 'worker-1', health_status: 'healthy' },
    });

    const refreshedWorkers = readFleetWorkers(projectRoot).registry;
    expect(refreshedWorkers?.workers[0]).toMatchObject({
      worker_id: 'worker-1',
      registered_at: registeredAt,
      max_concurrent_claims: 3,
      heartbeat_timeout_seconds: 60,
      accepts_claims: true,
      note: 'baseline worker',
    });
  });

  it('preserves an existing accepts_claims=false gate when refreshing worker liveness', async () => {
    const projectRoot = makeTmpDir();
    writeWorkers(projectRoot, {
      schema_version: 1,
      updated_at: '2026-03-22T00:00:00Z',
      workers: [{
        worker_id: 'worker-1',
        registered_at: '2026-03-22T00:00:00Z',
        last_heartbeat_at: '2026-03-22T00:00:00Z',
        accepts_claims: false,
        max_concurrent_claims: 1,
        heartbeat_timeout_seconds: 30,
        note: 'maintenance gate',
      }],
    });

    const payload = await handleOrchFleetWorkerHeartbeat(OrchFleetWorkerHeartbeatSchema.parse({
      project_root: projectRoot,
      worker_id: 'worker-1',
      max_concurrent_claims: 2,
      heartbeat_timeout_seconds: 45,
    })) as { worker: { accepts_claims: boolean; health_status: string; note?: string } };

    expect(payload.worker).toMatchObject({
      accepts_claims: false,
      health_status: 'healthy',
      note: 'maintenance gate',
    });
    expect(readFleetWorkers(projectRoot).registry?.workers[0]).toMatchObject({
      worker_id: 'worker-1',
      accepts_claims: false,
      max_concurrent_claims: 2,
      heartbeat_timeout_seconds: 45,
      note: 'maintenance gate',
    });
  });

  it('fails closed on invalid worker registry payloads', async () => {
    const projectRoot = makeTmpDir();
    writeWorkers(projectRoot, '{not-valid-json\n');

    await expect(handleOrchFleetWorkerHeartbeat(OrchFleetWorkerHeartbeatSchema.parse({
      project_root: projectRoot,
      worker_id: 'worker-1',
    }))).rejects.toMatchObject({
      code: 'INVALID_PARAMS',
      data: { fleet_workers_path: path.join(projectRoot, '.autoresearch', 'fleet_workers.json') },
    });
  });
});
