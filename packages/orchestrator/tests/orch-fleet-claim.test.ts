import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { readFleetQueue } from '../src/orch-tools/fleet-queue-store.js';
import { handleOrchFleetClaim, handleOrchFleetRelease } from '../src/orch-tools/fleet-queue-tools.js';
import { OrchFleetClaimSchema, OrchFleetReleaseSchema } from '../src/orch-tools/schemas.js';
import {
  baseState,
  buildLeaseClaim,
  cleanupTmpDirs,
  makeTmpDir,
  writeLedger,
  writeQueue,
  writeState,
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

function readQueue(projectRoot: string) {
  const result = readFleetQueue(projectRoot);
  expect(result.errors).toEqual([]);
  expect(result.queue).not.toBeNull();
  return result.queue!;
}

afterEach(() => {
  cleanupTmpDirs();
});

describe('orch_fleet_claim and orch_fleet_release', () => {
  it('claims queued items using the deterministic priority ordering', async () => {
    const projectRoot = makeTmpDir();
    writeProject(projectRoot);
    writeQueue(projectRoot, {
      schema_version: 1,
      updated_at: '2026-03-22T00:00:02Z',
      items: [
        { queue_item_id: 'fq_z', run_id: 'run-3', status: 'queued', priority: 3, enqueued_at: '2026-03-22T00:00:02Z', requested_by: 'operator', attempt_count: 0 },
        { queue_item_id: 'fq_b', run_id: 'run-2', status: 'queued', priority: 10, enqueued_at: '2026-03-22T00:00:00Z', requested_by: 'operator', attempt_count: 0 },
        { queue_item_id: 'fq_a', run_id: 'run-1', status: 'queued', priority: 10, enqueued_at: '2026-03-22T00:00:00Z', requested_by: 'operator', attempt_count: 0 },
      ],
    });

    const payload = await handleOrchFleetClaim(OrchFleetClaimSchema.parse({
      project_root: projectRoot,
      owner_id: 'worker-1',
    })) as { claimed: boolean; queue_item: { queue_item_id: string; claim?: { owner_id: string } } };

    expect(payload.claimed).toBe(true);
    expect(payload.queue_item.queue_item_id).toBe('fq_a');
    expect(payload.queue_item.claim?.owner_id).toBe('worker-1');
    expect(readQueue(projectRoot).items.find(item => item.queue_item_id === 'fq_a')).toMatchObject({
      status: 'claimed',
      claim: { owner_id: 'worker-1' },
    });
  });

  it('supports specific-run claims and returns a deterministic non-error when nothing is queued', async () => {
    const projectRoot = makeTmpDir();
    writeProject(projectRoot);
    writeQueue(projectRoot, {
      schema_version: 1,
      updated_at: '2026-03-22T00:00:01Z',
      items: [
        { queue_item_id: 'fq_1', run_id: 'run-1', status: 'queued', priority: 100, enqueued_at: '2026-03-22T00:00:00Z', requested_by: 'operator', attempt_count: 0 },
        { queue_item_id: 'fq_2', run_id: 'run-2', status: 'queued', priority: 1, enqueued_at: '2026-03-22T00:00:01Z', requested_by: 'operator', attempt_count: 0 },
      ],
    });

    const claimed = await handleOrchFleetClaim(OrchFleetClaimSchema.parse({
      project_root: projectRoot,
      owner_id: 'worker-2',
      run_id: 'run-2',
    })) as { claimed: boolean; queue_item: { run_id: string } };
    expect(claimed).toMatchObject({ claimed: true, queue_item: { run_id: 'run-2' } });

    const missing = await handleOrchFleetClaim(OrchFleetClaimSchema.parse({
      project_root: projectRoot,
      owner_id: 'worker-3',
      run_id: 'run-3',
    })) as { claimed: boolean; reason: string; diagnostic: string; queue_item: null };
    expect(missing).toEqual({
      claimed: false,
      project_root: projectRoot,
      reason: 'RUN_NOT_QUEUED',
      diagnostic: "run_id 'run-3' does not currently have a queued fleet item",
      queue_item: null,
    });
  });

  it('does not create a queue file when a claim finds no queued item', async () => {
    const projectRoot = makeTmpDir();
    writeProject(projectRoot);

    const payload = await handleOrchFleetClaim(OrchFleetClaimSchema.parse({
      project_root: projectRoot,
      owner_id: 'worker-1',
    })) as { claimed: boolean; reason: string };

    expect(payload).toMatchObject({ claimed: false, reason: 'NO_QUEUED_ITEM' });
    expect(fs.existsSync(path.join(projectRoot, '.autoresearch', 'fleet_queue.json'))).toBe(false);
  });

  it('fails closed on missing items, unclaimed items, and owner mismatch', async () => {
    const projectRoot = makeTmpDir();
    writeProject(projectRoot);
    writeQueue(projectRoot, {
      schema_version: 1,
      updated_at: '2026-03-22T00:00:01Z',
      items: [
        {
          queue_item_id: 'fq_claimed',
          run_id: 'run-1',
          status: 'claimed',
          priority: 0,
          enqueued_at: '2026-03-22T00:00:00Z',
          requested_by: 'operator',
          attempt_count: 1,
          claim: buildLeaseClaim({ claim_id: 'claim-1', owner_id: 'worker-1', claimed_at: '2026-03-22T00:01:00Z' }),
        },
        { queue_item_id: 'fq_queued', run_id: 'run-2', status: 'queued', priority: 0, enqueued_at: '2026-03-22T00:00:01Z', requested_by: 'operator', attempt_count: 0 },
      ],
    });

    await expect(handleOrchFleetRelease(OrchFleetReleaseSchema.parse({
      project_root: projectRoot,
      queue_item_id: 'fq_missing',
      owner_id: 'worker-1',
      disposition: 'completed',
    }))).rejects.toMatchObject({ code: 'NOT_FOUND' });

    await expect(handleOrchFleetRelease(OrchFleetReleaseSchema.parse({
      project_root: projectRoot,
      queue_item_id: 'fq_queued',
      owner_id: 'worker-1',
      disposition: 'completed',
    }))).rejects.toMatchObject({ code: 'INVALID_PARAMS' });

    await expect(handleOrchFleetRelease(OrchFleetReleaseSchema.parse({
      project_root: projectRoot,
      queue_item_id: 'fq_claimed',
      owner_id: 'worker-9',
      disposition: 'completed',
    }))).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
  });

  it.each(['requeue', 'completed', 'failed', 'cancelled'] as const)(
    'applies the %s release transition without creating a second ownership authority',
    async disposition => {
      const projectRoot = makeTmpDir();
      writeProject(projectRoot);
      writeQueue(projectRoot, {
        schema_version: 1,
        updated_at: '2026-03-22T00:01:00Z',
        items: [{
          queue_item_id: 'fq_claimed',
          run_id: 'run-1',
          status: 'claimed',
          priority: 4,
          enqueued_at: '2026-03-22T00:00:00Z',
          requested_by: 'operator',
          attempt_count: 2,
          claim: buildLeaseClaim({ claim_id: 'claim-1', owner_id: 'worker-1', claimed_at: '2026-03-22T00:01:00Z' }),
        }],
      });

      const payload = await handleOrchFleetRelease(OrchFleetReleaseSchema.parse({
        project_root: projectRoot,
        queue_item_id: 'fq_claimed',
        owner_id: 'worker-1',
        disposition,
      })) as { released: boolean; queue_item: { status: string; attempt_count: number; claim?: unknown } };

      expect(payload.released).toBe(true);
      expect(payload.queue_item.claim).toBeUndefined();
      expect(payload.queue_item.status).toBe(disposition === 'requeue' ? 'queued' : disposition);
      expect(payload.queue_item.attempt_count).toBe(disposition === 'requeue' ? 3 : 2);
      expect(fs.readFileSync(path.join(projectRoot, '.autoresearch', 'ledger.jsonl'), 'utf-8')).toContain('"event_type":"fleet_released"');
    },
  );

  it('persists resolved lease authority on new claims and audits it', async () => {
    const projectRoot = makeTmpDir();
    writeProject(projectRoot);
    writeQueue(projectRoot, {
      schema_version: 1,
      updated_at: '2026-03-22T00:00:02Z',
      items: [
        { queue_item_id: 'fq_default', run_id: 'run-1', status: 'queued', priority: 5, enqueued_at: '2026-03-22T00:00:00Z', requested_by: 'operator', attempt_count: 0 },
        { queue_item_id: 'fq_custom', run_id: 'run-2', status: 'queued', priority: 4, enqueued_at: '2026-03-22T00:00:01Z', requested_by: 'operator', attempt_count: 0 },
      ],
    });

    const defaultClaim = await handleOrchFleetClaim(OrchFleetClaimSchema.parse({
      project_root: projectRoot,
      owner_id: 'worker-default',
      run_id: 'run-1',
    })) as { queue_item: { claim?: { lease_duration_seconds: number; lease_expires_at: string } } };
    const customClaim = await handleOrchFleetClaim(OrchFleetClaimSchema.parse({
      project_root: projectRoot,
      owner_id: 'worker-custom',
      run_id: 'run-2',
      lease_duration_seconds: 15,
    })) as { queue_item: { claim?: { lease_duration_seconds: number; lease_expires_at: string } } };

    expect(defaultClaim.queue_item.claim).toMatchObject({ lease_duration_seconds: 60 });
    expect(customClaim.queue_item.claim).toMatchObject({ lease_duration_seconds: 15 });
    expect(typeof defaultClaim.queue_item.claim?.lease_expires_at).toBe('string');
    expect(typeof customClaim.queue_item.claim?.lease_expires_at).toBe('string');

    const ledger = fs.readFileSync(path.join(projectRoot, '.autoresearch', 'ledger.jsonl'), 'utf-8');
    expect(ledger).toContain('"lease_duration_seconds":60');
    expect(ledger).toContain('"lease_duration_seconds":15');
    expect(ledger).toContain('"lease_expires_at"');
  });
});
