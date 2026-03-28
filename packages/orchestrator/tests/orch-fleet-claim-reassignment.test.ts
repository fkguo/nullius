import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { handleOrchFleetReassignClaim } from '../src/orch-tools/fleet-claim-reassignment.js';
import { readFleetQueue } from '../src/orch-tools/fleet-queue-store.js';
import { OrchFleetReassignClaimSchema } from '../src/orch-tools/schemas.js';
import {
  cleanupTmpDirs,
  makeTmpDir,
  writeQueue,
  writeWorkers,
} from './orchFleetTestSupport.js';
import {
  claimedQueueItem,
  fleetWorker,
  writeInitializedProject,
} from './orchFleetClaimReassignmentSupport.js';
import { buildLeaseClaim } from './orchFleetTestSupport.js';

function readQueueItem(projectRoot: string, queueItemId = 'fq_claimed') {
  const result = readFleetQueue(projectRoot);
  expect(result.errors).toEqual([]);
  return result.queue?.items.find(item => item.queue_item_id === queueItemId);
}

afterEach(() => {
  cleanupTmpDirs();
});

describe('orch_fleet_reassign_claim', () => {
  it('replaces the live queue claim without mutating worker registry authority', async () => {
    const projectRoot = makeTmpDir();
    writeInitializedProject(projectRoot);
    const priorClaim = buildLeaseClaim({
      claim_id: 'claim-old',
      owner_id: 'worker-1',
      claimed_at: '2026-03-28T00:01:00Z',
      lease_duration_seconds: 90,
    });
    writeQueue(projectRoot, {
      schema_version: 1,
      updated_at: '2026-03-28T00:01:00Z',
      items: [
        claimedQueueItem({ priority: 4, attempt_count: 2, claim: priorClaim }),
        {
          queue_item_id: 'fq_other',
          run_id: 'run-2',
          status: 'claimed',
          priority: 3,
          enqueued_at: '2026-03-28T00:00:01Z',
          requested_by: 'operator',
          attempt_count: 0,
          claim: buildLeaseClaim({ claim_id: 'claim-other', owner_id: 'worker-2' }),
        },
      ],
    });
    writeWorkers(projectRoot, {
      schema_version: 1,
      updated_at: '2026-03-28T00:01:00Z',
      workers: [
        fleetWorker(),
        fleetWorker({ worker_id: 'worker-2', max_concurrent_claims: 2, note: 'target worker' }),
      ],
    });
    const workersBefore = fs.readFileSync(path.join(projectRoot, '.autoresearch', 'fleet_workers.json'), 'utf-8');

    const payload = await handleOrchFleetReassignClaim(OrchFleetReassignClaimSchema.parse({
      project_root: projectRoot,
      queue_item_id: 'fq_claimed',
      expected_claim_id: 'claim-old',
      expected_owner_id: 'worker-1',
      target_worker_id: 'worker-2',
      reassigned_by: 'operator',
      note: 'drain worker-1 manually',
    })) as {
      reassigned: boolean;
      prior_claim_id: string;
      prior_owner_id: string;
      queue_item: { status: string; attempt_count: number; priority: number; claim?: Record<string, string | number> };
    };

    expect(payload.reassigned).toBe(true);
    expect(payload.prior_claim_id).toBe('claim-old');
    expect(payload.prior_owner_id).toBe('worker-1');
    expect(payload.queue_item).toMatchObject({
      status: 'claimed',
      attempt_count: 2,
      priority: 4,
      claim: { owner_id: 'worker-2', lease_duration_seconds: 90 },
    });
    expect(payload.queue_item.claim?.claim_id).not.toBe('claim-old');
    expect(payload.queue_item.claim?.claimed_at).not.toBe(priorClaim.claimed_at);
    expect(payload.queue_item.claim?.lease_expires_at).not.toBe(priorClaim.lease_expires_at);
    expect(readQueueItem(projectRoot)).toMatchObject({
      status: 'claimed',
      attempt_count: 2,
      priority: 4,
      claim: { owner_id: 'worker-2', lease_duration_seconds: 90 },
    });
    expect(fs.readFileSync(path.join(projectRoot, '.autoresearch', 'fleet_workers.json'), 'utf-8')).toBe(workersBefore);
    const ledger = fs.readFileSync(path.join(projectRoot, '.autoresearch', 'ledger.jsonl'), 'utf-8');
    expect(ledger).toContain('"event_type":"fleet_claim_reassigned"');
    expect(ledger).toContain('"prior_claim_id":"claim-old"');
    expect(ledger).toContain('"new_owner_id":"worker-2"');
    expect(ledger).toContain('"reassigned_by":"operator"');
  });

  it('fails closed on stale identities, invalid target selection, and missing current owner workers', async () => {
    const staleClaimRoot = makeTmpDir();
    writeInitializedProject(staleClaimRoot);
    writeQueue(staleClaimRoot, {
      schema_version: 1,
      updated_at: '2026-03-28T00:01:00Z',
      items: [claimedQueueItem()],
    });
    writeWorkers(staleClaimRoot, {
      schema_version: 1,
      updated_at: '2026-03-28T00:01:00Z',
      workers: [fleetWorker(), fleetWorker({ worker_id: 'worker-2' })],
    });
    await expect(handleOrchFleetReassignClaim(OrchFleetReassignClaimSchema.parse({
      project_root: staleClaimRoot,
      queue_item_id: 'fq_claimed',
      expected_claim_id: 'claim-other',
      expected_owner_id: 'worker-1',
      target_worker_id: 'worker-2',
      reassigned_by: 'operator',
      note: 'stale view',
    }))).rejects.toMatchObject({
      code: 'INVALID_PARAMS',
      data: { queue_item_id: 'fq_claimed', expected_claim_id: 'claim-other', current_claim_id: 'claim-1' },
    });

    const sameTargetRoot = makeTmpDir();
    writeInitializedProject(sameTargetRoot);
    writeQueue(sameTargetRoot, JSON.parse(JSON.stringify(readFleetQueue(staleClaimRoot).queue)));
    writeWorkers(sameTargetRoot, {
      schema_version: 1,
      updated_at: '2026-03-28T00:01:00Z',
      workers: [fleetWorker()],
    });
    await expect(handleOrchFleetReassignClaim(OrchFleetReassignClaimSchema.parse({
      project_root: sameTargetRoot,
      queue_item_id: 'fq_claimed',
      expected_claim_id: 'claim-1',
      expected_owner_id: 'worker-1',
      target_worker_id: 'worker-1',
      reassigned_by: 'operator',
      note: 'no-op is forbidden',
    }))).rejects.toMatchObject({
      code: 'INVALID_PARAMS',
      data: { expected_owner_id: 'worker-1', target_worker_id: 'worker-1' },
    });

    const missingOwnerRoot = makeTmpDir();
    writeInitializedProject(missingOwnerRoot);
    writeQueue(missingOwnerRoot, JSON.parse(JSON.stringify(readFleetQueue(staleClaimRoot).queue)));
    writeWorkers(missingOwnerRoot, {
      schema_version: 1,
      updated_at: '2026-03-28T00:01:00Z',
      workers: [fleetWorker({ worker_id: 'worker-2' })],
    });
    await expect(handleOrchFleetReassignClaim(OrchFleetReassignClaimSchema.parse({
      project_root: missingOwnerRoot,
      queue_item_id: 'fq_claimed',
      expected_claim_id: 'claim-1',
      expected_owner_id: 'worker-1',
      target_worker_id: 'worker-2',
      reassigned_by: 'operator',
      note: 'owner disappeared',
    }))).rejects.toMatchObject({
      code: 'INVALID_PARAMS',
      data: { worker_id: 'worker-1', role: 'current owner' },
    });
  });
});
