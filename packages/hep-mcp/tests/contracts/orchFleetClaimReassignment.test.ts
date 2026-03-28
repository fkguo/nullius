import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

vi.mock('@autoresearch/zotero-mcp/tooling', () => ({
  TOOL_SPECS: [],
}));
vi.mock('../../src/core/zotero/tools.js', () => ({
  hepImportFromZotero: vi.fn(),
}));

import { handleToolCall } from '../../src/tools/index.js';
import {
  cleanupTmpDirs,
  extractPayload,
  makeTmpDir,
  writeJsonControlFile,
  writeProject,
} from './orchFleetClaimReassignmentContractSupport.js';

afterEach(() => {
  cleanupTmpDirs();
});

describe('orch_fleet_reassign_claim host contract', () => {
  it('routes explicit reassignment through the shared/orchestrator host path without mutating worker truth', async () => {
    const projectRoot = makeTmpDir();
    writeProject(projectRoot);
    writeJsonControlFile(projectRoot, 'fleet_queue.json', {
      schema_version: 1,
      updated_at: '2026-03-28T00:01:00Z',
      items: [{
        queue_item_id: 'fq_claimed',
        run_id: 'run-1',
        status: 'claimed',
        priority: 5,
        enqueued_at: '2026-03-28T00:00:00Z',
        requested_by: 'operator',
        attempt_count: 1,
        claim: {
          claim_id: 'claim-1',
          owner_id: 'worker-1',
          claimed_at: '2026-03-28T00:01:00Z',
          lease_duration_seconds: 60,
          lease_expires_at: '2026-03-28T00:02:00Z',
        },
      }],
    });
    writeJsonControlFile(projectRoot, 'fleet_workers.json', {
      schema_version: 1,
      updated_at: '2026-03-28T00:01:00Z',
      workers: [
        { worker_id: 'worker-1', registered_at: '2026-03-28T00:00:00Z', last_heartbeat_at: '2026-03-28T00:01:00Z', accepts_claims: true, max_concurrent_claims: 1, heartbeat_timeout_seconds: 60 },
        { worker_id: 'worker-2', registered_at: '2026-03-28T00:00:00Z', last_heartbeat_at: '2026-03-28T00:01:00Z', accepts_claims: true, max_concurrent_claims: 2, heartbeat_timeout_seconds: 60 },
      ],
    });
    const workersBefore = fs.readFileSync(path.join(projectRoot, '.autoresearch', 'fleet_workers.json'), 'utf-8');

    const res = await handleToolCall('orch_fleet_reassign_claim', {
      project_root: projectRoot,
      queue_item_id: 'fq_claimed',
      expected_claim_id: 'claim-1',
      expected_owner_id: 'worker-1',
      target_worker_id: 'worker-2',
      reassigned_by: 'operator',
      note: 'manual handoff',
    }, 'full');
    expect((res as { isError?: boolean }).isError).toBeFalsy();
    expect(extractPayload(res)).toMatchObject({
      reassigned: true,
      prior_claim_id: 'claim-1',
      prior_owner_id: 'worker-1',
      queue_item: { status: 'claimed', claim: { owner_id: 'worker-2', lease_duration_seconds: 60 } },
    });
    expect(fs.readFileSync(path.join(projectRoot, '.autoresearch', 'fleet_workers.json'), 'utf-8')).toBe(workersBefore);
    expect(fs.readFileSync(path.join(projectRoot, '.autoresearch', 'ledger.jsonl'), 'utf-8')).toContain('"event_type":"fleet_claim_reassigned"');
  });

  it('fails closed through the host path when the current owner is missing or the target worker is full', async () => {
    const missingOwnerRoot = makeTmpDir();
    writeProject(missingOwnerRoot);
    writeJsonControlFile(missingOwnerRoot, 'fleet_queue.json', {
      schema_version: 1,
      updated_at: '2026-03-28T00:01:00Z',
      items: [{
        queue_item_id: 'fq_claimed',
        run_id: 'run-1',
        status: 'claimed',
        priority: 5,
        enqueued_at: '2026-03-28T00:00:00Z',
        requested_by: 'operator',
        attempt_count: 1,
        claim: {
          claim_id: 'claim-1',
          owner_id: 'worker-1',
          claimed_at: '2026-03-28T00:01:00Z',
          lease_duration_seconds: 60,
          lease_expires_at: '2026-03-28T00:02:00Z',
        },
      }],
    });
    writeJsonControlFile(missingOwnerRoot, 'fleet_workers.json', {
      schema_version: 1,
      updated_at: '2026-03-28T00:01:00Z',
      workers: [
        { worker_id: 'worker-2', registered_at: '2026-03-28T00:00:00Z', last_heartbeat_at: '2026-03-28T00:01:00Z', accepts_claims: true, max_concurrent_claims: 1, heartbeat_timeout_seconds: 60 },
      ],
    });
    const missingOwner = await handleToolCall('orch_fleet_reassign_claim', {
      project_root: missingOwnerRoot,
      queue_item_id: 'fq_claimed',
      expected_claim_id: 'claim-1',
      expected_owner_id: 'worker-1',
      target_worker_id: 'worker-2',
      reassigned_by: 'operator',
      note: 'missing owner',
    }, 'full');
    expect((missingOwner as { isError?: boolean }).isError).toBe(true);
    expect(extractPayload(missingOwner).error).toMatchObject({
      code: 'INVALID_PARAMS',
      data: { worker_id: 'worker-1', role: 'current owner' },
    });

    const atCapacityRoot = makeTmpDir();
    writeProject(atCapacityRoot);
    writeJsonControlFile(atCapacityRoot, 'fleet_queue.json', {
      schema_version: 1,
      updated_at: '2026-03-28T00:01:00Z',
      items: [
        {
          queue_item_id: 'fq_claimed',
          run_id: 'run-1',
          status: 'claimed',
          priority: 5,
          enqueued_at: '2026-03-28T00:00:00Z',
          requested_by: 'operator',
          attempt_count: 1,
          claim: { claim_id: 'claim-1', owner_id: 'worker-1', claimed_at: '2026-03-28T00:01:00Z', lease_duration_seconds: 60, lease_expires_at: '2026-03-28T00:02:00Z' },
        },
        {
          queue_item_id: 'fq_target_owned',
          run_id: 'run-2',
          status: 'claimed',
          priority: 4,
          enqueued_at: '2026-03-28T00:00:01Z',
          requested_by: 'operator',
          attempt_count: 0,
          claim: { claim_id: 'claim-2', owner_id: 'worker-2', claimed_at: '2026-03-28T00:01:10Z', lease_duration_seconds: 60, lease_expires_at: '2026-03-28T00:02:10Z' },
        },
      ],
    });
    writeJsonControlFile(atCapacityRoot, 'fleet_workers.json', {
      schema_version: 1,
      updated_at: '2026-03-28T00:01:00Z',
      workers: [
        { worker_id: 'worker-1', registered_at: '2026-03-28T00:00:00Z', last_heartbeat_at: '2026-03-28T00:01:00Z', accepts_claims: true, max_concurrent_claims: 1, heartbeat_timeout_seconds: 60 },
        { worker_id: 'worker-2', registered_at: '2026-03-28T00:00:00Z', last_heartbeat_at: '2026-03-28T00:01:00Z', accepts_claims: true, max_concurrent_claims: 1, heartbeat_timeout_seconds: 60 },
      ],
    });
    const atCapacity = await handleToolCall('orch_fleet_reassign_claim', {
      project_root: atCapacityRoot,
      queue_item_id: 'fq_claimed',
      expected_claim_id: 'claim-1',
      expected_owner_id: 'worker-1',
      target_worker_id: 'worker-2',
      reassigned_by: 'operator',
      note: 'target full',
    }, 'full');
    expect((atCapacity as { isError?: boolean }).isError).toBe(true);
    expect(extractPayload(atCapacity).error).toMatchObject({
      code: 'INVALID_PARAMS',
      data: { target_worker_id: 'worker-2', active_claim_count: 1, max_concurrent_claims: 1 },
    });
  });
});
