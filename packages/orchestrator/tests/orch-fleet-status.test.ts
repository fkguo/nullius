import { afterEach, describe, expect, it } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import { handleOrchFleetStatus } from '../src/orch-tools/fleet-status.js';
import { OrchFleetStatusSchema } from '../src/orch-tools/schemas.js';
import {
  baseState,
  cleanupTmpDirs,
  makeTmpDir,
  writeApprovalPacket,
  writeLedger,
  writeQueue,
  writeState,
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
  });

  it('keeps per-project file problems inside errors[] instead of failing the whole snapshot', async () => {
    const projectRoot = makeTmpDir();
    writeLedger(projectRoot, ['{not-valid-json']);
    writeQueue(projectRoot, '{not-valid-json\n');

    const payload = await handleOrchFleetStatus(OrchFleetStatusSchema.parse({
      project_roots: [projectRoot],
    })) as {
      summary: { error_count: number };
      projects: Array<{ errors: Array<{ code: string }> }>;
    };

    expect(payload.summary.error_count).toBe(3);
    expect(payload.projects[0]?.errors.map(item => item.code)).toEqual([
      'STATE_MISSING',
      'LEDGER_PARSE_ERROR',
      'FLEET_QUEUE_PARSE_ERROR',
    ]);
  });

  it('accepts the legacy complete alias but filters on completed status', async () => {
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

    const payload = await handleOrchFleetStatus(OrchFleetStatusSchema.parse({
      project_roots: [projectRoot],
      status_filter: 'complete',
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
});
