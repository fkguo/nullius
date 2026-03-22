import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { readFleetQueue } from '../src/orch-tools/fleet-queue-store.js';
import { handleOrchFleetAdjudicateStaleClaim } from '../src/orch-tools/fleet-queue-tools.js';
import { OrchFleetAdjudicateStaleClaimSchema } from '../src/orch-tools/schemas.js';
import {
  baseState,
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

describe('orch_fleet_adjudicate_stale_claim', () => {
  it('requeues a claimed item only when the expected claim identity still matches', async () => {
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
        claim: { claim_id: 'claim-1', owner_id: 'worker-1', claimed_at: '2026-03-22T00:01:00Z' },
      }],
    });

    const payload = await handleOrchFleetAdjudicateStaleClaim(OrchFleetAdjudicateStaleClaimSchema.parse({
      project_root: projectRoot,
      queue_item_id: 'fq_claimed',
      expected_claim_id: 'claim-1',
      expected_owner_id: 'worker-1',
      adjudicated_by: 'operator-1',
      disposition: 'requeue',
      note: 'worker heartbeat is stale and the operator explicitly chose to requeue',
    })) as { adjudicated: boolean; queue_item: { status: string; attempt_count: number; claim?: unknown } };

    expect(payload).toMatchObject({
      adjudicated: true,
      queue_item: {
        status: 'queued',
        attempt_count: 3,
      },
    });
    expect(payload.queue_item.claim).toBeUndefined();
    expect(readQueue(projectRoot).items[0]).toMatchObject({
      status: 'queued',
      attempt_count: 3,
    });
    expect(readQueue(projectRoot).items[0]?.claim).toBeUndefined();
    const ledgerLines = fs.readFileSync(path.join(projectRoot, '.autoresearch', 'ledger.jsonl'), 'utf-8').trim().split('\n');
    const adjudicationEvent = JSON.parse(ledgerLines.at(-1) ?? '{}') as {
      event_type?: string;
      details?: Record<string, unknown>;
    };
    expect(adjudicationEvent).toMatchObject({
      event_type: 'fleet_claim_adjudicated',
      details: {
        queue_item_id: 'fq_claimed',
        prior_claim_id: 'claim-1',
        prior_owner_id: 'worker-1',
        adjudicated_by: 'operator-1',
        disposition: 'requeue',
        note: 'worker heartbeat is stale and the operator explicitly chose to requeue',
      },
    });
  });

  it.each(['completed', 'failed', 'cancelled'] as const)(
    'settles a claimed item to %s without incrementing attempt_count',
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
          claim: { claim_id: 'claim-1', owner_id: 'worker-1', claimed_at: '2026-03-22T00:01:00Z' },
        }],
      });

      const payload = await handleOrchFleetAdjudicateStaleClaim(OrchFleetAdjudicateStaleClaimSchema.parse({
        project_root: projectRoot,
        queue_item_id: 'fq_claimed',
        expected_claim_id: 'claim-1',
        expected_owner_id: 'worker-1',
        adjudicated_by: 'operator-1',
        disposition,
        note: `operator explicitly settled the stale claim as ${disposition}`,
      })) as { queue_item: { status: string; attempt_count: number; claim?: unknown } };

      expect(payload.queue_item).toMatchObject({
        status: disposition,
        attempt_count: 2,
      });
      expect(payload.queue_item.claim).toBeUndefined();
    }
  );

  it('fails closed when the expected claim_id or owner no longer matches', async () => {
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
        claim: { claim_id: 'claim-2', owner_id: 'worker-2', claimed_at: '2026-03-22T00:01:00Z' },
      }],
    });

    await expect(handleOrchFleetAdjudicateStaleClaim(OrchFleetAdjudicateStaleClaimSchema.parse({
      project_root: projectRoot,
      queue_item_id: 'fq_claimed',
      expected_claim_id: 'claim-1',
      expected_owner_id: 'worker-1',
      adjudicated_by: 'operator-1',
      disposition: 'requeue',
      note: 'operator inspected an older claim snapshot',
    }))).rejects.toMatchObject({
      code: 'INVALID_PARAMS',
      data: expect.objectContaining({
        expected_claim_id: 'claim-1',
        current_claim_id: 'claim-2',
      }),
    });

    await expect(handleOrchFleetAdjudicateStaleClaim(OrchFleetAdjudicateStaleClaimSchema.parse({
      project_root: projectRoot,
      queue_item_id: 'fq_claimed',
      expected_claim_id: 'claim-2',
      expected_owner_id: 'worker-1',
      adjudicated_by: 'operator-1',
      disposition: 'requeue',
      note: 'operator inspected an older owner snapshot',
    }))).rejects.toMatchObject({
      code: 'INVALID_PARAMS',
      data: expect.objectContaining({
        expected_owner_id: 'worker-1',
        current_owner_id: 'worker-2',
      }),
    });
  });

  it('fails closed for missing queue items, unclaimed items, and invalid queue payloads', async () => {
    const missingProjectRoot = makeTmpDir();
    writeProject(missingProjectRoot);
    await expect(handleOrchFleetAdjudicateStaleClaim(OrchFleetAdjudicateStaleClaimSchema.parse({
      project_root: missingProjectRoot,
      queue_item_id: 'fq_missing',
      expected_claim_id: 'claim-1',
      expected_owner_id: 'worker-1',
      adjudicated_by: 'operator-1',
      disposition: 'requeue',
      note: 'operator attempted to adjudicate a missing claim',
    }))).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(fs.existsSync(path.join(missingProjectRoot, '.autoresearch', 'fleet_queue.json'))).toBe(false);

    const unclaimedProjectRoot = makeTmpDir();
    writeProject(unclaimedProjectRoot);
    writeQueue(unclaimedProjectRoot, {
      schema_version: 1,
      updated_at: '2026-03-22T00:01:00Z',
      items: [{
        queue_item_id: 'fq_queued',
        run_id: 'run-1',
        status: 'queued',
        priority: 4,
        enqueued_at: '2026-03-22T00:00:00Z',
        requested_by: 'operator',
        attempt_count: 0,
      }],
    });
    await expect(handleOrchFleetAdjudicateStaleClaim(OrchFleetAdjudicateStaleClaimSchema.parse({
      project_root: unclaimedProjectRoot,
      queue_item_id: 'fq_queued',
      expected_claim_id: 'claim-1',
      expected_owner_id: 'worker-1',
      adjudicated_by: 'operator-1',
      disposition: 'requeue',
      note: 'operator attempted to adjudicate an unclaimed item',
    }))).rejects.toMatchObject({ code: 'INVALID_PARAMS' });

    const invalidQueueProjectRoot = makeTmpDir();
    writeProject(invalidQueueProjectRoot);
    writeQueue(invalidQueueProjectRoot, '{not-valid-json\n');
    await expect(handleOrchFleetAdjudicateStaleClaim(OrchFleetAdjudicateStaleClaimSchema.parse({
      project_root: invalidQueueProjectRoot,
      queue_item_id: 'fq_claimed',
      expected_claim_id: 'claim-1',
      expected_owner_id: 'worker-1',
      adjudicated_by: 'operator-1',
      disposition: 'requeue',
      note: 'operator attempted to adjudicate against an invalid queue file',
    }))).rejects.toMatchObject({
      code: 'INVALID_PARAMS',
      data: expect.objectContaining({
        fleet_queue_path: `${invalidQueueProjectRoot}/.autoresearch/fleet_queue.json`,
      }),
    });
  });
});
