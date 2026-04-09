import { afterEach, describe, expect, it } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import { handleOrchFleetWorkerUnregister } from '../src/orch-tools/fleet-worker-unregister.js';
import { handleOrchFleetStatus } from '../src/orch-tools/fleet-status.js';
import { buildFleetQueueDiagnosticItems } from '../src/orch-tools/fleet-status-diagnostics.js';
import {
  OrchFleetStatusSchema,
  OrchFleetWorkerUnregisterSchema,
} from '../src/orch-tools/schemas.js';
import {
  baseState,
  buildLeaseClaim,
  cleanupTmpDirs,
  makeTmpDir,
  writeApprovalPacket,
  writeLedger,
  writeQueue,
  writeState,
  writeWorkers,
} from './orchFleetTestSupport.js';

afterEach(() => {
  cleanupTmpDirs();
});

describe('orch_fleet_status', () => {
  it('aggregates deduped project roots with current-run approval visibility', async () => {
    const homeProjectRoot = makeTmpDir('orch-fleet-', os.homedir());
    const approvalId = 'A1-0001';
    writeState(homeProjectRoot, baseState({
      run_id: 'run-awaiting',
      run_status: 'awaiting_approval',
      pending_approval: {
        approval_id: approvalId,
        category: 'A1',
        plan_step_ids: [],
        requested_at: '2026-03-22T00:01:00Z',
        timeout_at: null,
        on_timeout: 'block',
        packet_path: `artifacts/runs/run-awaiting/approvals/${approvalId}/packet_short.md`,
      },
    }));
    writeLedger(homeProjectRoot, [
      {
        ts: '2026-03-22T00:00:00Z',
        event_type: 'initialized',
        run_id: 'run-awaiting',
        workflow_id: 'runtime',
        step_id: null,
        details: {},
      },
      {
        ts: '2026-03-22T00:01:00Z',
        event_type: 'approval_requested',
        run_id: 'run-awaiting',
        workflow_id: 'runtime',
        step_id: null,
        details: { approval_id: approvalId, category: 'A1' },
      },
    ]);
    writeApprovalPacket(homeProjectRoot, 'run-awaiting', approvalId);
    writeQueue(homeProjectRoot, {
      schema_version: 1,
      updated_at: '2026-03-22T00:02:00Z',
      items: [{
        queue_item_id: 'fq_001',
        run_id: 'run-awaiting',
        status: 'queued',
        priority: 5,
        enqueued_at: '2026-03-22T00:01:30Z',
        requested_by: 'operator',
        attempt_count: 0,
      }],
    });

    const tildeRoot = `~/${path.basename(homeProjectRoot)}`;
    const payload = await handleOrchFleetStatus(OrchFleetStatusSchema.parse({
      project_roots: [tildeRoot, homeProjectRoot],
    })) as {
      summary: { project_count: number; run_count: number; pending_approval_count: number; by_status: Record<string, number> };
      projects: Array<{
        approvals: Array<Record<string, unknown>>;
        current_run: Record<string, unknown> | null;
        queue: { queue_initialized: boolean; total: number; by_status: Record<string, number> };
        workers: {
          workers_initialized: boolean;
          total: number;
          by_health: Record<string, number>;
          capacity: { total_slots: number; claimed_slots: number; available_slots: number };
        };
        errors: unknown[];
      }>;
    };

    expect(payload.summary.project_count).toBe(1);
    expect(payload.summary.run_count).toBe(1);
    expect(payload.summary.pending_approval_count).toBe(1);
    expect(payload.summary.by_status.awaiting_approval).toBe(1);
    expect(payload.projects[0]?.errors).toEqual([]);
    expect(payload.projects[0]?.current_run?.run_id).toBe('run-awaiting');
    expect(payload.projects[0]?.approvals[0]?.status).toBe('pending');
    expect(payload.projects[0]?.queue.queue_initialized).toBe(true);
    expect(payload.projects[0]?.queue.total).toBe(1);
    expect(payload.projects[0]?.queue.by_status.queued).toBe(1);
    expect(payload.projects[0]?.workers.workers_initialized).toBe(false);
  });

  it('keeps per-project file problems inside errors[] instead of failing the whole snapshot', async () => {
    const projectRoot = makeTmpDir();
    writeLedger(projectRoot, ['{not-valid-json']);
    writeQueue(projectRoot, '{not-valid-json\n');
    writeWorkers(projectRoot, '{not-valid-json\n');

    const payload = await handleOrchFleetStatus(OrchFleetStatusSchema.parse({
      project_roots: [projectRoot],
    })) as {
      summary: { error_count: number };
      projects: Array<{ errors: Array<{ code: string }> }>;
    };

    expect(payload.summary.error_count).toBe(4);
    expect(payload.projects[0]?.errors.map(item => item.code)).toEqual([
      'STATE_MISSING',
      'LEDGER_PARSE_ERROR',
      'FLEET_QUEUE_PARSE_ERROR',
      'FLEET_WORKERS_PARSE_ERROR',
    ]);
  });

  it('rejects the retired complete alias and requires completed', async () => {
    const projectRoot = makeTmpDir();
    writeState(projectRoot, baseState({
      run_id: 'run-completed',
      run_status: 'completed',
    }));
    writeLedger(projectRoot, [
      {
        ts: '2026-03-22T00:00:00Z',
        event_type: 'status_completed',
        run_id: 'run-completed',
        workflow_id: 'runtime',
        step_id: null,
        details: {},
      },
      {
        ts: '2026-03-22T00:01:00Z',
        event_type: 'status_failed',
        run_id: 'run-failed',
        workflow_id: 'runtime',
        step_id: null,
        details: {},
      },
    ]);

    expect(() => OrchFleetStatusSchema.parse({
      project_roots: [projectRoot],
      status_filter: 'complete',
    })).toThrow();

    const payload = await handleOrchFleetStatus(OrchFleetStatusSchema.parse({
      project_roots: [projectRoot],
      status_filter: 'completed',
    })) as {
      projects: Array<{
        runs: Array<{ run_id: string; last_status: string }>;
        queue: { queue_initialized: boolean; items: unknown[] };
      }>;
    };

    expect(payload.projects[0]?.runs).toEqual([
      { run_id: 'run-completed', last_event: 'status_completed', last_status: 'completed', timestamp_utc: '2026-03-22T00:00:00Z', uri: 'orch://runs/run-completed' },
    ]);
    expect(payload.projects[0]?.queue.queue_initialized).toBe(false);
    expect(payload.projects[0]?.queue.items).toEqual([]);
    expect(payload.projects[0]?.workers.workers_initialized).toBe(false);
  });

  it('surfaces unmapped ledger events instead of silently hiding the status fallback', async () => {
    const projectRoot = makeTmpDir();
    writeState(projectRoot, baseState({
      run_id: 'run-unknown',
      run_status: 'idle',
    }));
    writeLedger(projectRoot, [
      {
        ts: '2026-03-22T00:00:00Z',
        event_type: 'custom_operator_note',
        run_id: 'run-unknown',
        workflow_id: 'runtime',
        step_id: null,
        details: {},
      },
    ]);

    const payload = await handleOrchFleetStatus(OrchFleetStatusSchema.parse({
      project_roots: [projectRoot],
    })) as {
      projects: Array<{ runs: Array<{ last_status: string }>; errors: Array<{ code: string; message: string }> }>;
    };

    expect(payload.projects[0]?.runs[0]?.last_status).toBe('unknown');
    expect(payload.projects[0]?.errors.map(item => item.code)).toContain('LEDGER_EVENT_UNMAPPED');
    expect(payload.projects[0]?.errors.find(item => item.code === 'LEDGER_EVENT_UNMAPPED')?.message).toContain('custom_operator_note x1');
  });

  it('derives worker health and slot usage from fleet_workers plus queue claims without creating a second authority', async () => {
    const projectRoot = makeTmpDir();
    const now = new Date();
    const recentHeartbeat = new Date(now.getTime() - 5_000).toISOString();
    const staleHeartbeat = new Date(now.getTime() - 60_000).toISOString();
    writeState(projectRoot, baseState({ run_id: 'run-1', run_status: 'running' }));
    writeLedger(projectRoot, [{
      ts: '2026-03-22T00:00:00Z',
      event_type: 'run_started',
      run_id: 'run-1',
      workflow_id: 'runtime',
      step_id: null,
      details: {},
    }]);
    writeQueue(projectRoot, {
      schema_version: 1,
      updated_at: '2026-03-22T00:00:00Z',
      items: [{
        queue_item_id: 'fq_claimed',
        run_id: 'run-1',
        status: 'claimed',
        priority: 1,
        enqueued_at: '2026-03-22T00:00:00Z',
        requested_by: 'operator',
        attempt_count: 0,
        claim: buildLeaseClaim({ claim_id: 'fqc_1', owner_id: 'worker-healthy', claimed_at: '2026-03-22T00:00:00Z' }),
      }],
    });
    writeWorkers(projectRoot, {
      schema_version: 1,
      updated_at: '2026-03-22T00:00:40Z',
      workers: [
        {
          worker_id: 'worker-healthy',
          registered_at: '2026-03-22T00:00:00Z',
          last_heartbeat_at: recentHeartbeat,
          accepts_claims: true,
          max_concurrent_claims: 2,
          heartbeat_timeout_seconds: 30,
        },
        {
          worker_id: 'worker-stale',
          registered_at: '2026-03-22T00:00:00Z',
          last_heartbeat_at: staleHeartbeat,
          accepts_claims: false,
          max_concurrent_claims: 1,
          heartbeat_timeout_seconds: 5,
        },
      ],
    });

    const payload = await handleOrchFleetStatus(OrchFleetStatusSchema.parse({
      project_roots: [projectRoot],
    })) as {
      summary: {
        worker_count: number;
        healthy_worker_count: number;
        stale_worker_count: number;
        accepting_worker_count: number;
        not_accepting_worker_count: number;
        total_worker_slots: number;
        claimed_worker_slots: number;
        available_worker_slots: number;
      };
      projects: Array<{
        workers: {
          total: number;
          by_health: Record<string, number>;
          claim_acceptance: { accepting_workers: number; not_accepting_workers: number };
          capacity: { total_slots: number; claimed_slots: number; available_slots: number };
          workers: Array<{ worker_id: string; active_claim_count: number; health_status: string; available_slots: number; accepts_claims: boolean }>;
        };
      }>;
    };

    expect(payload.summary).toMatchObject({
      worker_count: 2,
      healthy_worker_count: 1,
      stale_worker_count: 1,
      accepting_worker_count: 1,
      not_accepting_worker_count: 1,
      total_worker_slots: 3,
      claimed_worker_slots: 1,
      available_worker_slots: 2,
    });
    expect(payload.projects[0]?.workers.by_health).toEqual({ healthy: 1, stale: 1 });
    expect(payload.projects[0]?.workers.claim_acceptance).toEqual({ accepting_workers: 1, not_accepting_workers: 1 });
    expect(payload.projects[0]?.workers.capacity).toEqual({ total_slots: 3, claimed_slots: 1, available_slots: 2 });
    expect(payload.projects[0]?.workers.workers.find(item => item.worker_id === 'worker-healthy')).toMatchObject({
      health_status: 'healthy',
      active_claim_count: 1,
      available_slots: 1,
      accepts_claims: true,
    });
    expect(payload.projects[0]?.workers.workers.find(item => item.worker_id === 'worker-stale')).toMatchObject({
      health_status: 'stale',
      active_claim_count: 0,
      available_slots: 1,
      accepts_claims: false,
    });
  });

  it('derives slot usage from the full queue authority even when queue item visibility is limited', async () => {
    const projectRoot = makeTmpDir();
    writeState(projectRoot, baseState({ run_id: 'run-1', run_status: 'running' }));
    writeLedger(projectRoot, [{
      ts: '2026-03-22T00:00:00Z',
      event_type: 'run_started',
      run_id: 'run-1',
      workflow_id: 'runtime',
      step_id: null,
      details: {},
    }]);
    writeQueue(projectRoot, {
      schema_version: 1,
      updated_at: '2026-03-22T00:00:30Z',
      items: [
        {
          queue_item_id: 'fq_claimed_1',
          run_id: 'run-1',
          status: 'claimed',
          priority: 2,
          enqueued_at: '2026-03-22T00:00:00Z',
          requested_by: 'operator',
          attempt_count: 0,
          claim: buildLeaseClaim({ claim_id: 'fqc_1', owner_id: 'worker-1', claimed_at: '2026-03-22T00:00:00Z' }),
        },
        {
          queue_item_id: 'fq_claimed_2',
          run_id: 'run-2',
          status: 'claimed',
          priority: 1,
          enqueued_at: '2026-03-22T00:00:10Z',
          requested_by: 'operator',
          attempt_count: 0,
          claim: buildLeaseClaim({ claim_id: 'fqc_2', owner_id: 'worker-1', claimed_at: '2026-03-22T00:00:10Z' }),
        },
      ],
    });
    writeWorkers(projectRoot, {
      schema_version: 1,
      updated_at: '2026-03-22T00:00:35Z',
      workers: [{
        worker_id: 'worker-1',
        registered_at: '2026-03-22T00:00:00Z',
        last_heartbeat_at: new Date().toISOString(),
        accepts_claims: true,
        max_concurrent_claims: 3,
        heartbeat_timeout_seconds: 60,
      }],
    });

    const payload = await handleOrchFleetStatus(OrchFleetStatusSchema.parse({
      project_roots: [projectRoot],
      limit_per_project: 1,
    })) as {
      summary: { claimed_worker_slots: number; available_worker_slots: number };
      projects: Array<{
        queue: { returned: number; total: number };
        workers: {
          capacity: { claimed_slots: number; available_slots: number };
          workers: Array<{ worker_id: string; active_claim_count: number; available_slots: number }>;
        };
      }>;
    };

    expect(payload.projects[0]?.queue).toMatchObject({ returned: 1, total: 2 });
    expect(payload.summary).toMatchObject({
      claimed_worker_slots: 2,
      available_worker_slots: 1,
    });
    expect(payload.projects[0]?.workers.capacity).toEqual({
      total_slots: 3,
      claimed_slots: 2,
      available_slots: 1,
    });
    expect(payload.projects[0]?.workers.workers.find(item => item.worker_id === 'worker-1')).toMatchObject({
      active_claim_count: 2,
      available_slots: 1,
    });
  });

  it('adds operator stale-signal diagnostics for healthy, stale, and missing worker claims', async () => {
    const projectRoot = makeTmpDir();
    const now = new Date();
    const healthyHeartbeat = new Date(now.getTime() - 4_000).toISOString();
    const staleHeartbeat = new Date(now.getTime() - 70_000).toISOString();
    writeState(projectRoot, baseState({ run_id: 'run-1', run_status: 'running' }));
    writeLedger(projectRoot, [{
      ts: '2026-03-22T00:00:00Z',
      event_type: 'run_started',
      run_id: 'run-1',
      workflow_id: 'runtime',
      step_id: null,
      details: {},
    }]);
    writeQueue(projectRoot, {
      schema_version: 1,
      updated_at: now.toISOString(),
      items: [
        {
          queue_item_id: 'fq_healthy',
          run_id: 'run-healthy',
          status: 'claimed',
          priority: 3,
          enqueued_at: '2026-03-22T00:00:00Z',
          requested_by: 'operator',
          attempt_count: 0,
          claim: buildLeaseClaim({
            claim_id: 'fqc_healthy',
            owner_id: 'worker-healthy',
            claimed_at: new Date(now.getTime() - 25_000).toISOString(),
            lease_duration_seconds: 60,
          }),
        },
        {
          queue_item_id: 'fq_stale',
          run_id: 'run-stale',
          status: 'claimed',
          priority: 2,
          enqueued_at: '2026-03-22T00:00:01Z',
          requested_by: 'operator',
          attempt_count: 0,
          claim: buildLeaseClaim({
            claim_id: 'fqc_stale',
            owner_id: 'worker-stale',
            claimed_at: new Date(now.getTime() - 40_000).toISOString(),
            lease_duration_seconds: 30,
          }),
        },
        {
          queue_item_id: 'fq_missing',
          run_id: 'run-missing',
          status: 'claimed',
          priority: 1,
          enqueued_at: '2026-03-22T00:00:02Z',
          requested_by: 'operator',
          attempt_count: 0,
          claim: buildLeaseClaim({
            claim_id: 'fqc_missing',
            owner_id: 'worker-missing',
            claimed_at: new Date(now.getTime() - 15_000).toISOString(),
            lease_duration_seconds: 60,
          }),
        },
      ],
    });
    writeWorkers(projectRoot, {
      schema_version: 1,
      updated_at: now.toISOString(),
      workers: [
        {
          worker_id: 'worker-healthy',
          registered_at: '2026-03-22T00:00:00Z',
          last_heartbeat_at: healthyHeartbeat,
          accepts_claims: true,
          max_concurrent_claims: 1,
          heartbeat_timeout_seconds: 30,
        },
        {
          worker_id: 'worker-stale',
          registered_at: '2026-03-22T00:00:00Z',
          last_heartbeat_at: staleHeartbeat,
          accepts_claims: false,
          max_concurrent_claims: 1,
          heartbeat_timeout_seconds: 5,
        },
      ],
    });

    const payload = await handleOrchFleetStatus(OrchFleetStatusSchema.parse({
      project_roots: [projectRoot],
    })) as {
      summary: {
        attention_claim_count: number;
        claimed_without_worker_count: number;
        claimed_with_stale_worker_count: number;
        expired_claim_count: number;
      };
      projects: Array<{
        queue: {
          attention_claim_count: number;
          claimed_without_worker_count: number;
          claimed_with_stale_worker_count: number;
          expired_claim_count: number;
          items: Array<{
            queue_item_id: string;
            claim_age_seconds: number | null;
            lease_expires_at: string | null;
            lease_remaining_seconds: number | null;
            lease_expired: boolean;
            last_heartbeat_at: string | null;
            last_heartbeat_age_seconds: number | null;
            owner_worker_health: string | null;
            attention_required: boolean;
            attention_reasons: string[];
          }>;
        };
      }>;
    };

    expect(payload.summary).toMatchObject({
      attention_claim_count: 2,
      claimed_without_worker_count: 1,
      claimed_with_stale_worker_count: 1,
      expired_claim_count: 1,
    });
    expect(payload.projects[0]?.queue).toMatchObject({
      attention_claim_count: 2,
      claimed_without_worker_count: 1,
      claimed_with_stale_worker_count: 1,
      expired_claim_count: 1,
    });
    expect(payload.projects[0]?.queue.items.find(item => item.queue_item_id === 'fq_healthy')).toMatchObject({
      owner_worker_health: 'healthy',
      attention_required: false,
      attention_reasons: [],
      last_heartbeat_at: healthyHeartbeat,
      lease_expired: false,
    });
    expect(payload.projects[0]?.queue.items.find(item => item.queue_item_id === 'fq_healthy')?.claim_age_seconds).not.toBeNull();
    expect(payload.projects[0]?.queue.items.find(item => item.queue_item_id === 'fq_healthy')?.last_heartbeat_age_seconds).not.toBeNull();
    expect(payload.projects[0]?.queue.items.find(item => item.queue_item_id === 'fq_healthy')?.lease_remaining_seconds).not.toBeNull();
    expect(payload.projects[0]?.queue.items.find(item => item.queue_item_id === 'fq_stale')).toMatchObject({
      owner_worker_health: 'stale',
      attention_required: true,
      attention_reasons: ['OWNER_WORKER_STALE'],
      last_heartbeat_at: staleHeartbeat,
      lease_expired: true,
    });
    expect(payload.projects[0]?.queue.items.find(item => item.queue_item_id === 'fq_missing')).toMatchObject({
      owner_worker_health: null,
      attention_required: true,
      attention_reasons: ['OWNER_WORKER_MISSING'],
      last_heartbeat_at: null,
      last_heartbeat_age_seconds: null,
    });
  });

  it('flags claimed items when the worker registry is invalid without mutating queue truth', async () => {
    const projectRoot = makeTmpDir();
    const claimedAt = new Date(Date.now() - 10_000).toISOString();
    writeState(projectRoot, baseState({ run_id: 'run-1', run_status: 'running' }));
    writeLedger(projectRoot, [{
      ts: '2026-03-22T00:00:00Z',
      event_type: 'run_started',
      run_id: 'run-1',
      workflow_id: 'runtime',
      step_id: null,
      details: {},
    }]);
    writeQueue(projectRoot, {
      schema_version: 1,
      updated_at: '2026-03-22T00:00:05Z',
      items: [{
        queue_item_id: 'fq_invalid_workers',
        run_id: 'run-1',
        status: 'claimed',
        priority: 1,
        enqueued_at: '2026-03-22T00:00:00Z',
        requested_by: 'operator',
        attempt_count: 0,
        claim: buildLeaseClaim({ claim_id: 'fqc_1', owner_id: 'worker-1', claimed_at: claimedAt }),
      }],
    });
    writeWorkers(projectRoot, '{not-valid-json\n');

    const payload = await handleOrchFleetStatus(OrchFleetStatusSchema.parse({
      project_roots: [projectRoot],
    })) as {
      summary: { attention_claim_count: number };
      projects: Array<{
        errors: Array<{ code: string }>;
        queue: {
          attention_claim_count: number;
          items: Array<{ queue_item_id: string; attention_required: boolean; attention_reasons: string[] }>;
        };
      }>;
    };

    expect(payload.projects[0]?.errors.map(item => item.code)).toContain('FLEET_WORKERS_PARSE_ERROR');
    expect(payload.summary.attention_claim_count).toBe(1);
    expect(payload.projects[0]?.queue.attention_claim_count).toBe(1);
    expect(payload.projects[0]?.queue.items).toEqual([
      expect.objectContaining({
        queue_item_id: 'fq_invalid_workers',
        attention_required: true,
        attention_reasons: ['QUEUE_OR_WORKER_REGISTRY_INVALID'],
      }),
    ]);
  });

  it('reflects unregister through the existing worker read model without changing status shape', async () => {
    const projectRoot = makeTmpDir();
    writeState(projectRoot, baseState({ run_id: 'run-1', run_status: 'idle' }));
    writeLedger(projectRoot, [{
      ts: '2026-03-23T00:00:00Z',
      event_type: 'initialized',
      run_id: 'run-1',
      workflow_id: 'runtime',
      step_id: null,
      details: {},
    }]);
    writeWorkers(projectRoot, {
      schema_version: 1,
      updated_at: '2026-03-23T00:00:00Z',
      workers: [{
        worker_id: 'worker-1',
        registered_at: '2026-03-23T00:00:00Z',
        last_heartbeat_at: new Date().toISOString(),
        accepts_claims: false,
        max_concurrent_claims: 1,
        heartbeat_timeout_seconds: 30,
      }],
    });
    await handleOrchFleetWorkerUnregister(OrchFleetWorkerUnregisterSchema.parse({
      project_root: projectRoot,
      worker_id: 'worker-1',
      unregistered_by: 'operator',
      note: 'drain complete',
    }));

    const payload = await handleOrchFleetStatus(OrchFleetStatusSchema.parse({
      project_roots: [projectRoot],
    })) as {
      summary: { worker_count: number; healthy_worker_count: number };
      projects: Array<{
        workers: { total: number; workers_initialized: boolean; workers: unknown[] };
      }>;
    };

    expect(payload.summary.worker_count).toBe(0);
    expect(payload.summary.healthy_worker_count).toBe(0);
    expect(payload.projects[0]?.workers).toMatchObject({
      total: 0,
      workers_initialized: true,
      workers: [],
    });
  });

  it('flags missing claim owner metadata without inventing a worker fallback', () => {
    const items = buildFleetQueueDiagnosticItems([
      {
        queue_item_id: 'fq_missing_owner',
        run_id: 'run-1',
        status: 'claimed',
        priority: 1,
        enqueued_at: '2026-03-22T00:00:00Z',
        requested_by: 'operator',
        attempt_count: 0,
        claim: buildLeaseClaim({ claim_id: 'fqc_1', owner_id: '', claimed_at: '2026-03-22T00:00:01Z' }),
      },
    ], [], []);

    expect(items).toEqual([
      expect.objectContaining({
        queue_item_id: 'fq_missing_owner',
        attention_required: true,
        attention_reasons: ['CLAIM_WITHOUT_OWNER'],
        owner_worker_health: null,
        last_heartbeat_at: null,
        last_heartbeat_age_seconds: null,
      }),
    ]);
  });
});
