import * as fs from 'node:fs';
import * as path from 'node:path';
import { invalidParams } from '@autoresearch/shared';
import { z } from 'zod';
import { createStateManager, pauseFilePath, requireState } from './common.js';
import { OrchRunCreateSchema, OrchRunListSchema, OrchRunStatusSchema } from './schemas.js';

function buildIdleState(runId: string, workflowId?: string) {
  return {
    schema_version: 1 as const,
    run_id: runId,
    workflow_id: workflowId ?? null,
    run_status: 'idle' as const,
    current_step: null,
    plan: null,
    plan_md_path: null,
    checkpoints: { last_checkpoint_at: null, checkpoint_interval_seconds: 900 },
    pending_approval: null,
    approval_seq: { A1: 0, A2: 0, A3: 0, A4: 0, A5: 0 },
    gate_satisfied: {},
    approval_history: [],
    artifacts: {},
    notes: '',
  };
}

export async function handleOrchRunCreate(
  params: z.output<typeof OrchRunCreateSchema>,
): Promise<unknown> {
  const { manager, projectRoot } = createStateManager(params.project_root);
  manager.ensureDirs();
  if (fs.existsSync(manager.statePath)) {
    const existing = JSON.parse(fs.readFileSync(manager.statePath, 'utf-8')) as Record<string, unknown>;
    const existingKey = typeof existing.idempotency_key === 'string' ? existing.idempotency_key : undefined;
    if (params.idempotency_key && existingKey === params.idempotency_key) {
      return {
        idempotency_replay: true,
        run_id: existing.run_id,
        run_status: existing.run_status,
        uri: `orch://runs/${existing.run_id}`,
        message: `Idempotency replay: existing run with key "${params.idempotency_key}"`,
      };
    }
    if (params.idempotency_key && existingKey && existingKey !== params.idempotency_key) {
      throw invalidParams(
        `idempotency_conflict: existing run has key "${existingKey}", requested "${params.idempotency_key}"`,
        { existing_key: existingKey, requested_key: params.idempotency_key },
      );
    }
  }

  const state = buildIdleState(params.run_id, params.workflow_id);
  if (params.idempotency_key) {
    (state as Record<string, unknown>).idempotency_key = params.idempotency_key;
  }
  manager.saveState(state);

  const initializedPath = path.join(path.dirname(manager.statePath), '.initialized');
  if (!fs.existsSync(initializedPath)) {
    fs.writeFileSync(initializedPath, `${new Date().toISOString()}\n`, 'utf-8');
  }
  manager.appendLedger('initialized', {
    run_id: params.run_id,
    workflow_id: params.workflow_id ?? null,
    details: { source: 'orch_run_create' },
  });

  return {
    run_id: params.run_id,
    run_status: 'idle',
    uri: `orch://runs/${params.run_id}`,
    project_root: projectRoot,
    message: `Run "${params.run_id}" created.`,
  };
}

export async function handleOrchRunStatus(
  params: z.output<typeof OrchRunStatusSchema>,
): Promise<unknown> {
  const { manager, projectRoot } = createStateManager(params.project_root);
  const state = requireState(projectRoot, manager);
  const paused = fs.existsSync(pauseFilePath(projectRoot));
  return {
    run_id: state.run_id,
    run_status: paused ? 'paused' : state.run_status,
    workflow_id: state.workflow_id ?? null,
    current_step: state.current_step ?? null,
    pending_approval: state.pending_approval ?? null,
    gate_satisfied: state.gate_satisfied ?? {},
    notes: state.notes ?? '',
    uri: state.run_id ? `orch://runs/${state.run_id}` : null,
    is_paused: paused,
  };
}

export async function handleOrchRunList(
  params: z.output<typeof OrchRunListSchema>,
): Promise<unknown> {
  const { manager } = createStateManager(params.project_root);
  if (!fs.existsSync(manager.ledgerPath)) {
    return { runs: [], total: 0 };
  }

  const runMap = new Map<string, { run_id: string; last_event: string; last_status: string; timestamp_utc: string }>();
  const lines = fs.readFileSync(manager.ledgerPath, 'utf-8').split('\n').filter(line => line.trim());
  for (const line of lines) {
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const runId = typeof event.run_id === 'string' ? event.run_id : null;
    if (!runId) {
      continue;
    }
    const eventType = typeof event.event_type === 'string' ? event.event_type : '';
    const timestamp = typeof event.ts === 'string'
      ? event.ts
      : (typeof event.timestamp_utc === 'string' ? event.timestamp_utc : '');
    const entry = runMap.get(runId) ?? { run_id: runId, last_event: eventType, last_status: 'unknown', timestamp_utc: timestamp };
    entry.last_event = eventType;
    entry.timestamp_utc = timestamp;
    if (eventType === 'initialized') entry.last_status = 'idle';
    else if (eventType === 'approval_requested') entry.last_status = 'awaiting_approval';
    else if (eventType === 'approval_approved' || eventType === 'resumed') entry.last_status = 'running';
    else if (eventType === 'approval_rejected' || eventType === 'paused') entry.last_status = 'paused';
    runMap.set(runId, entry);
  }

  let runs = [...runMap.values()].sort((left, right) => right.timestamp_utc.localeCompare(left.timestamp_utc));
  if (params.status_filter !== 'all') {
    runs = runs.filter(run => run.last_status === params.status_filter);
  }
  const limited = runs.slice(0, params.limit);
  return {
    runs: limited.map(run => ({ ...run, uri: `orch://runs/${run.run_id}` })),
    total: runMap.size,
    returned: limited.length,
  };
}
