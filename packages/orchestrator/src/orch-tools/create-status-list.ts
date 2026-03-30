import * as fs from 'node:fs';
import * as path from 'node:path';
import { APPROVAL_GATE_IDS, invalidParams } from '@autoresearch/shared';
import { z } from 'zod';
import { createStateManager, requireState } from './common.js';
import { buildRunStatusView, readRunListView } from './run-read-model.js';
import { OrchRunCreateSchema, OrchRunListSchema, OrchRunStatusSchema } from './schemas.js';

function approvalSequenceTemplate(): Record<string, number> {
  return Object.fromEntries(
    APPROVAL_GATE_IDS.map((gateId) => [gateId, 0] as const),
  ) as Record<string, number>;
}

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
    approval_seq: approvalSequenceTemplate(),
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
  return buildRunStatusView(projectRoot, state);
}

export async function handleOrchRunList(
  params: z.output<typeof OrchRunListSchema>,
): Promise<unknown> {
  const { manager } = createStateManager(params.project_root);
  const { runs, total, returned, errors } = readRunListView(manager, params);
  return { runs, total, returned, errors };
}
