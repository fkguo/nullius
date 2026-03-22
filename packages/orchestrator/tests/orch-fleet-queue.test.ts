import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { readFleetQueue } from '../src/orch-tools/fleet-queue-store.js';
import { handleOrchFleetEnqueue } from '../src/orch-tools/fleet-queue-tools.js';
import { OrchFleetEnqueueSchema } from '../src/orch-tools/schemas.js';
import {
  baseState,
  cleanupTmpDirs,
  makeTmpDir,
  writeLedger,
  writeQueue,
  writeState,
} from './orchFleetTestSupport.js';

function readQueue(projectRoot: string) {
  const result = readFleetQueue(projectRoot);
  expect(result.errors).toEqual([]);
  expect(result.queue).not.toBeNull();
  return result.queue!;
}

afterEach(() => {
  cleanupTmpDirs();
});

describe('orch_fleet_enqueue', () => {
  it('fails closed for an unknown run_id', async () => {
    const projectRoot = makeTmpDir();
    writeState(projectRoot, baseState({ run_id: 'run-known' }));
    writeLedger(projectRoot, [{
      ts: '2026-03-22T00:00:00Z',
      event_type: 'initialized',
      run_id: 'run-known',
      workflow_id: 'runtime',
      step_id: null,
      details: {},
    }]);

    await expect(handleOrchFleetEnqueue(OrchFleetEnqueueSchema.parse({
      project_root: projectRoot,
      run_id: 'run-missing',
      requested_by: 'operator',
    }))).rejects.toMatchObject({
      code: 'INVALID_PARAMS',
      data: expect.objectContaining({ run_id: 'run-missing' }),
    });
  });

  it('creates the queue file on first enqueue and rejects duplicate active items', async () => {
    const projectRoot = makeTmpDir();
    writeState(projectRoot, baseState({ run_id: 'run-1' }));
    writeLedger(projectRoot, [{
      ts: '2026-03-22T00:00:00Z',
      event_type: 'initialized',
      run_id: 'run-1',
      workflow_id: 'runtime',
      step_id: null,
      details: {},
    }]);

    const payload = await handleOrchFleetEnqueue(OrchFleetEnqueueSchema.parse({
      project_root: projectRoot,
      run_id: 'run-1',
      requested_by: 'operator',
      priority: 7,
      note: 'first pass',
    })) as { enqueued: boolean; queue_item: { queue_item_id: string; status: string; priority: number; note?: string } };

    expect(payload.enqueued).toBe(true);
    expect(payload.queue_item.status).toBe('queued');
    expect(payload.queue_item.priority).toBe(7);
    expect(payload.queue_item.note).toBe('first pass');
    expect(readQueue(projectRoot).items).toHaveLength(1);
    expect(fs.readFileSync(path.join(projectRoot, '.autoresearch', 'ledger.jsonl'), 'utf-8')).toContain('"event_type":"fleet_enqueued"');

    await expect(handleOrchFleetEnqueue(OrchFleetEnqueueSchema.parse({
      project_root: projectRoot,
      run_id: 'run-1',
      requested_by: 'operator',
    }))).rejects.toMatchObject({
      code: 'INVALID_PARAMS',
      data: expect.objectContaining({
        queue_item_id: payload.queue_item.queue_item_id,
        status: 'queued',
      }),
    });
  });

  it('allows re-enqueue after only terminal queue items remain', async () => {
    const projectRoot = makeTmpDir();
    writeState(projectRoot, baseState({ run_id: 'run-1' }));
    writeLedger(projectRoot, [{
      ts: '2026-03-22T00:00:00Z',
      event_type: 'initialized',
      run_id: 'run-1',
      workflow_id: 'runtime',
      step_id: null,
      details: {},
    }]);
    writeQueue(projectRoot, {
      schema_version: 1,
      updated_at: '2026-03-22T00:00:00Z',
      items: [{
        queue_item_id: 'fq_terminal',
        run_id: 'run-1',
        status: 'completed',
        priority: 1,
        enqueued_at: '2026-03-22T00:00:00Z',
        requested_by: 'operator',
        attempt_count: 1,
      }],
    });

    const payload = await handleOrchFleetEnqueue(OrchFleetEnqueueSchema.parse({
      project_root: projectRoot,
      run_id: 'run-1',
      requested_by: 'operator',
    })) as { queue_item: { queue_item_id: string } };

    const queue = readQueue(projectRoot);
    expect(queue.items.map(item => item.queue_item_id)).toEqual(['fq_terminal', payload.queue_item.queue_item_id]);
    expect(queue.items.map(item => item.status)).toEqual(['completed', 'queued']);
  });

  it.each([
    ['{not-valid-json\n', 'FLEET_QUEUE_PARSE_ERROR'],
    [{ updated_at: '2026-03-22T00:00:00Z', items: [] }, 'FLEET_QUEUE_SCHEMA_ERROR'],
  ])('fails closed when the on-disk queue is invalid (%s)', async (queueContent, errorCode) => {
    const projectRoot = makeTmpDir();
    writeState(projectRoot, baseState({ run_id: 'run-1' }));
    writeLedger(projectRoot, [{
      ts: '2026-03-22T00:00:00Z',
      event_type: 'initialized',
      run_id: 'run-1',
      workflow_id: 'runtime',
      step_id: null,
      details: {},
    }]);
    writeQueue(projectRoot, queueContent);

    await expect(handleOrchFleetEnqueue(OrchFleetEnqueueSchema.parse({
      project_root: projectRoot,
      run_id: 'run-1',
      requested_by: 'operator',
    }))).rejects.toMatchObject({
      code: 'INVALID_PARAMS',
      data: expect.objectContaining({
        errors: [expect.objectContaining({ code: errorCode })],
      }),
    });
  });
});
