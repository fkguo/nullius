import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { readFleetQueue } from '../src/orch-tools/fleet-queue-store.js';
import { readFleetWorkers } from '../src/orch-tools/fleet-worker-store.js';
import { handleOrchFleetWorkerPoll } from '../src/orch-tools/fleet-worker-tools.js';
import { OrchFleetWorkerPollSchema } from '../src/orch-tools/schemas.js';
import { baseState, cleanupTmpDirs, makeTmpDir, writeLedger, writeQueue, writeState, writeWorkers } from './orchFleetTestSupport.js';

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

describe('orch_fleet_worker_poll', () => {
  it('registers the worker and claims the next queued item through the queue authority', async () => {
    const projectRoot = makeTmpDir();
    writeProject(projectRoot);
    writeQueue(projectRoot, {
      schema_version: 1,
      updated_at: '2026-03-22T00:00:01Z',
      items: [
        { queue_item_id: 'fq_low', run_id: 'run-2', status: 'queued', priority: 1, enqueued_at: '2026-03-22T00:00:02Z', requested_by: 'operator', attempt_count: 0 },
        { queue_item_id: 'fq_high', run_id: 'run-1', status: 'queued', priority: 9, enqueued_at: '2026-03-22T00:00:00Z', requested_by: 'operator', attempt_count: 0 },
      ],
    });

    const payload = await handleOrchFleetWorkerPoll(OrchFleetWorkerPollSchema.parse({
      project_root: projectRoot,
      worker_id: 'worker-1',
      max_concurrent_claims: 2,
      heartbeat_timeout_seconds: 60,
      note: 'primary worker',
    })) as {
      claimed: boolean;
      queue_item: { queue_item_id: string; claim?: { owner_id: string } };
      worker: { active_claim_count: number; available_slots: number; note?: string; health_status: string };
    };

    expect(payload.claimed).toBe(true);
    expect(payload.queue_item.queue_item_id).toBe('fq_high');
    expect(payload.queue_item.claim?.owner_id).toBe('worker-1');
    expect(payload.worker).toMatchObject({
      active_claim_count: 1,
      available_slots: 1,
      note: 'primary worker',
      health_status: 'healthy',
    });

    const queue = readFleetQueue(projectRoot).queue;
    expect(queue?.items.find(item => item.queue_item_id === 'fq_high')).toMatchObject({
      status: 'claimed',
      claim: { owner_id: 'worker-1' },
    });
    const workers = readFleetWorkers(projectRoot).registry;
    expect(workers?.workers).toHaveLength(1);
    expect(workers?.workers[0]).toMatchObject({
      worker_id: 'worker-1',
      max_concurrent_claims: 2,
      heartbeat_timeout_seconds: 60,
      note: 'primary worker',
    });
    expect(fs.readFileSync(path.join(projectRoot, '.autoresearch', 'ledger.jsonl'), 'utf-8')).toContain('"event_type":"fleet_claimed"');
  });

  it('returns deterministic non-errors for no queued item and at-capacity without changing queue ownership', async () => {
    const emptyProjectRoot = makeTmpDir();
    writeProject(emptyProjectRoot);
    const noQueuedItem = await handleOrchFleetWorkerPoll(OrchFleetWorkerPollSchema.parse({
      project_root: emptyProjectRoot,
      worker_id: 'worker-empty',
      max_concurrent_claims: 1,
      heartbeat_timeout_seconds: 30,
    })) as { claimed: boolean; reason: string; queue_item: null; worker: { active_claim_count: number } };

    expect(noQueuedItem).toMatchObject({
      claimed: false,
      reason: 'NO_QUEUED_ITEM',
      queue_item: null,
      worker: { active_claim_count: 0 },
    });
    expect(readFleetWorkers(emptyProjectRoot).registry?.workers).toHaveLength(1);

    const cappedProjectRoot = makeTmpDir();
    writeProject(cappedProjectRoot);
    writeQueue(cappedProjectRoot, {
      schema_version: 1,
      updated_at: '2026-03-22T00:00:01Z',
      items: [
        {
          queue_item_id: 'fq_claimed',
          run_id: 'run-1',
          status: 'claimed',
          priority: 10,
          enqueued_at: '2026-03-22T00:00:00Z',
          requested_by: 'operator',
          attempt_count: 1,
          claim: { claim_id: 'fqc_1', owner_id: 'worker-1', claimed_at: '2026-03-22T00:00:00Z' },
        },
        { queue_item_id: 'fq_waiting', run_id: 'run-2', status: 'queued', priority: 8, enqueued_at: '2026-03-22T00:00:01Z', requested_by: 'operator', attempt_count: 0 },
      ],
    });
    const atCapacity = await handleOrchFleetWorkerPoll(OrchFleetWorkerPollSchema.parse({
      project_root: cappedProjectRoot,
      worker_id: 'worker-1',
      max_concurrent_claims: 1,
      heartbeat_timeout_seconds: 30,
    })) as { claimed: boolean; reason: string; queue_item: null; worker: { active_claim_count: number; available_slots: number } };

    expect(atCapacity).toMatchObject({
      claimed: false,
      reason: 'AT_CAPACITY',
      queue_item: null,
      worker: { active_claim_count: 1, available_slots: 0 },
    });
    expect(readFleetQueue(cappedProjectRoot).queue?.items.find(item => item.queue_item_id === 'fq_waiting')?.status).toBe('queued');
  });

  it('fails closed when the worker registry or queue file is invalid', async () => {
    const invalidWorkersProjectRoot = makeTmpDir();
    writeProject(invalidWorkersProjectRoot);
    writeWorkers(invalidWorkersProjectRoot, '{not-valid-json\n');

    await expect(handleOrchFleetWorkerPoll(OrchFleetWorkerPollSchema.parse({
      project_root: invalidWorkersProjectRoot,
      worker_id: 'worker-1',
    }))).rejects.toMatchObject({
      code: 'INVALID_PARAMS',
      data: { fleet_workers_path: path.join(invalidWorkersProjectRoot, '.autoresearch', 'fleet_workers.json') },
    });

    const schemaInvalidWorkersProjectRoot = makeTmpDir();
    writeProject(schemaInvalidWorkersProjectRoot);
    writeWorkers(schemaInvalidWorkersProjectRoot, {
      schema_version: 99,
      updated_at: '2026-03-22T00:00:00Z',
      workers: [],
    });
    await expect(handleOrchFleetWorkerPoll(OrchFleetWorkerPollSchema.parse({
      project_root: schemaInvalidWorkersProjectRoot,
      worker_id: 'worker-1',
    }))).rejects.toMatchObject({
      code: 'INVALID_PARAMS',
      data: {
        fleet_workers_path: path.join(schemaInvalidWorkersProjectRoot, '.autoresearch', 'fleet_workers.json'),
        errors: [{ code: 'FLEET_WORKERS_SCHEMA_ERROR' }],
      },
    });

    const invalidQueueProjectRoot = makeTmpDir();
    writeProject(invalidQueueProjectRoot);
    writeQueue(invalidQueueProjectRoot, '{not-valid-json\n');
    await expect(handleOrchFleetWorkerPoll(OrchFleetWorkerPollSchema.parse({
      project_root: invalidQueueProjectRoot,
      worker_id: 'worker-1',
    }))).rejects.toMatchObject({
      code: 'INVALID_PARAMS',
      data: { fleet_queue_path: `${invalidQueueProjectRoot}/.autoresearch/fleet_queue.json` },
    });
  });
});
