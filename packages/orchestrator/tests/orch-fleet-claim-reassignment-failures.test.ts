import { afterEach, describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { handleOrchFleetReassignClaim } from '../src/orch-tools/fleet-claim-reassignment.js';
import { readFleetQueue } from '../src/orch-tools/fleet-queue-store.js';
import { OrchFleetReassignClaimSchema } from '../src/orch-tools/schemas.js';
import {
  buildLeaseClaim,
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

function writeClaimedProject(
  projectRoot: string,
  {
    queueItems = [claimedQueueItem()],
    workers = [fleetWorker(), fleetWorker({ worker_id: 'worker-2' })],
  }: {
    queueItems?: unknown[];
    workers?: unknown[];
  } = {},
): void {
  writeInitializedProject(projectRoot);
  writeQueue(projectRoot, {
    schema_version: 1,
    updated_at: '2026-03-28T00:01:00Z',
    items: queueItems,
  });
  writeWorkers(projectRoot, {
    schema_version: 1,
    updated_at: '2026-03-28T00:01:00Z',
    workers,
  });
}

function reassignmentPayload(projectRoot: string, overrides: Record<string, unknown> = {}) {
  return OrchFleetReassignClaimSchema.parse({
    project_root: projectRoot,
    queue_item_id: 'fq_claimed',
    expected_claim_id: 'claim-1',
    expected_owner_id: 'worker-1',
    target_worker_id: 'worker-2',
    reassigned_by: 'operator',
    note: 'manual reassignment',
    ...overrides,
  });
}

afterEach(() => {
  cleanupTmpDirs();
});

describe('orch_fleet_reassign_claim fail-closed target validation', () => {
  it('rejects missing queue items, non-claimed items, and stale identities', async () => {
    const missingItemRoot = makeTmpDir();
    writeClaimedProject(missingItemRoot);
    await expect(handleOrchFleetReassignClaim(reassignmentPayload(missingItemRoot, {
      queue_item_id: 'fq_missing',
    }))).rejects.toMatchObject({
      code: 'NOT_FOUND',
      data: { queue_item_id: 'fq_missing' },
    });

    const queuedItemRoot = makeTmpDir();
    writeClaimedProject(queuedItemRoot, {
      queueItems: [
        {
          ...claimedQueueItem(),
          status: 'queued',
          claim: undefined,
        },
      ],
    });
    await expect(handleOrchFleetReassignClaim(reassignmentPayload(queuedItemRoot))).rejects.toMatchObject({
      code: 'INVALID_PARAMS',
      data: { queue_item_id: 'fq_claimed', status: 'queued' },
    });

    const staleClaimRoot = makeTmpDir();
    writeClaimedProject(staleClaimRoot);
    await expect(handleOrchFleetReassignClaim(reassignmentPayload(staleClaimRoot, {
      expected_claim_id: 'claim-other',
    }))).rejects.toMatchObject({
      code: 'INVALID_PARAMS',
      data: { queue_item_id: 'fq_claimed', expected_claim_id: 'claim-other', current_claim_id: 'claim-1' },
    });

    await expect(handleOrchFleetReassignClaim(reassignmentPayload(staleClaimRoot, {
      expected_owner_id: 'worker-9',
    }))).rejects.toMatchObject({
      code: 'INVALID_PARAMS',
      data: { queue_item_id: 'fq_claimed', expected_owner_id: 'worker-9', current_owner_id: 'worker-1' },
    });
  });

  it('rejects self-reassignment and missing current or target workers', async () => {
    const sameTargetRoot = makeTmpDir();
    writeClaimedProject(sameTargetRoot, {
      workers: [fleetWorker()],
    });
    await expect(handleOrchFleetReassignClaim(reassignmentPayload(sameTargetRoot, {
      target_worker_id: 'worker-1',
    }))).rejects.toMatchObject({
      code: 'INVALID_PARAMS',
      data: { expected_owner_id: 'worker-1', target_worker_id: 'worker-1' },
    });

    const missingOwnerRoot = makeTmpDir();
    writeClaimedProject(missingOwnerRoot, {
      workers: [fleetWorker({ worker_id: 'worker-2' })],
    });
    await expect(handleOrchFleetReassignClaim(reassignmentPayload(missingOwnerRoot))).rejects.toMatchObject({
      code: 'INVALID_PARAMS',
      data: { worker_id: 'worker-1', role: 'current owner' },
    });

    const missingTargetRoot = makeTmpDir();
    writeClaimedProject(missingTargetRoot, {
      workers: [fleetWorker()],
    });
    await expect(handleOrchFleetReassignClaim(reassignmentPayload(missingTargetRoot))).rejects.toMatchObject({
      code: 'INVALID_PARAMS',
      data: { worker_id: 'worker-2', role: 'target' },
    });
  });

  it('rejects unavailable targets, full targets, and invalid worker registries', async () => {
    const unavailableRoot = makeTmpDir();
    writeClaimedProject(unavailableRoot, {
      workers: [fleetWorker(), fleetWorker({ worker_id: 'worker-2', accepts_claims: false })],
    });
    await expect(handleOrchFleetReassignClaim(reassignmentPayload(unavailableRoot, {
      note: 'target is paused',
    }))).rejects.toMatchObject({
      code: 'INVALID_PARAMS',
      data: { target_worker_id: 'worker-2', accepts_claims: false },
    });

    const atCapacityRoot = makeTmpDir();
    writeClaimedProject(atCapacityRoot, {
      queueItems: [
        claimedQueueItem(),
        {
          queue_item_id: 'fq_target_owned',
          run_id: 'run-2',
          status: 'claimed',
          priority: 1,
          enqueued_at: '2026-03-28T00:00:01Z',
          requested_by: 'operator',
          attempt_count: 1,
          claim: buildLeaseClaim({ claim_id: 'claim-2', owner_id: 'worker-2' }),
        },
      ],
      workers: [fleetWorker(), fleetWorker({ worker_id: 'worker-2', max_concurrent_claims: 1 })],
    });
    await expect(handleOrchFleetReassignClaim(reassignmentPayload(atCapacityRoot, {
      note: 'target is full',
    }))).rejects.toMatchObject({
      code: 'INVALID_PARAMS',
      data: { target_worker_id: 'worker-2', active_claim_count: 1, max_concurrent_claims: 1 },
    });

    const invalidWorkersRoot = makeTmpDir();
    writeInitializedProject(invalidWorkersRoot);
    writeQueue(invalidWorkersRoot, JSON.parse(JSON.stringify(readFleetQueue(unavailableRoot).queue)));
    writeWorkers(invalidWorkersRoot, '{not-valid-json\n');
    await expect(handleOrchFleetReassignClaim(reassignmentPayload(invalidWorkersRoot, {
      note: 'registry is broken',
    }))).rejects.toMatchObject({
      code: 'INVALID_PARAMS',
      data: { fleet_workers_path: path.join(invalidWorkersRoot, '.autoresearch', 'fleet_workers.json') },
    });
  });
});
