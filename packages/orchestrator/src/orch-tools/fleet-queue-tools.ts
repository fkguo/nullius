import { randomUUID } from 'node:crypto';
import { invalidParams, notFound, type FleetQueueV1 } from '@autoresearch/shared';
import { utcNowIso } from '../util.js';
import { createStateManager } from './common.js';
import { readRunListView } from './run-read-model.js';
import {
  createEmptyFleetQueue,
  readFleetQueue,
  writeFleetQueue,
  type FleetQueueClaim,
  type FleetQueueItem,
} from './fleet-queue-store.js';
import {
  OrchFleetClaimSchema,
  OrchFleetEnqueueSchema,
  OrchFleetReleaseSchema,
} from './schemas.js';

type FleetQueueDisposition = 'requeue' | 'completed' | 'failed' | 'cancelled';

function requireValidQueue(projectRoot: string): FleetQueueV1 {
  const readResult = readFleetQueue(projectRoot);
  if (readResult.errors.length > 0) {
    throw invalidParams('fleet queue is invalid', {
      fleet_queue_path: `${projectRoot}/.autoresearch/fleet_queue.json`,
      errors: readResult.errors,
    });
  }
  return readResult.queue ?? createEmptyFleetQueue();
}

function assertKnownRun(projectRoot: string, runId: string): void {
  const { manager } = createStateManager(projectRoot);
  const state = manager.readState();
  if (state.run_id === runId) {
    return;
  }
  const runList = readRunListView(manager, { limit: Number.MAX_SAFE_INTEGER, status_filter: 'all' });
  if (runList.runs.some(run => run.run_id === runId)) {
    return;
  }
  throw invalidParams(`unknown run_id '${runId}' for ${projectRoot}`, {
    run_id: runId,
    project_root: projectRoot,
    read_model_errors: runList.errors,
  });
}

export function sortQueuedItems(items: FleetQueueItem[]): FleetQueueItem[] {
  return [...items].sort((left, right) =>
    (right.priority - left.priority)
    || left.enqueued_at.localeCompare(right.enqueued_at)
    || left.queue_item_id.localeCompare(right.queue_item_id)
  );
}

function clearClaim(item: FleetQueueItem, nextStatus: FleetQueueItem['status']): FleetQueueItem {
  const nextItem: FleetQueueItem = { ...item, status: nextStatus };
  delete nextItem.claim;
  return nextItem;
}

function missingClaimResponse(projectRoot: string, runId?: string): {
  claimed: false;
  project_root: string;
  reason: 'RUN_NOT_QUEUED' | 'NO_QUEUED_ITEM';
  diagnostic: string;
  queue_item: null;
} {
  if (runId) {
    return {
      claimed: false,
      project_root: projectRoot,
      reason: 'RUN_NOT_QUEUED',
      diagnostic: `run_id '${runId}' does not currently have a queued fleet item`,
      queue_item: null,
    };
  }
  return {
    claimed: false,
    project_root: projectRoot,
    reason: 'NO_QUEUED_ITEM',
    diagnostic: 'no queued fleet item is available to claim',
    queue_item: null,
  };
}

function findActiveItem(queue: FleetQueueV1, runId: string): FleetQueueItem | undefined {
  return queue.items.find(item => item.run_id === runId && (item.status === 'queued' || item.status === 'claimed'));
}

export async function handleOrchFleetEnqueue(
  params: Parameters<typeof OrchFleetEnqueueSchema.parse>[0],
): Promise<unknown> {
  const parsed = OrchFleetEnqueueSchema.parse(params);
  const { manager, projectRoot } = createStateManager(parsed.project_root);
  assertKnownRun(projectRoot, parsed.run_id);

  const queue = requireValidQueue(projectRoot);
  const conflict = findActiveItem(queue, parsed.run_id);
  if (conflict) {
    throw invalidParams(`run '${parsed.run_id}' already has active queue item '${conflict.queue_item_id}'`, {
      run_id: parsed.run_id,
      queue_item_id: conflict.queue_item_id,
      status: conflict.status,
    });
  }

  const item: FleetQueueItem = {
    queue_item_id: `fq_${randomUUID()}`,
    run_id: parsed.run_id,
    status: 'queued',
    priority: parsed.priority,
    enqueued_at: utcNowIso(),
    requested_by: parsed.requested_by,
    attempt_count: 0,
    ...(parsed.note ? { note: parsed.note } : {}),
  };
  queue.items.push(item);
  writeFleetQueue(projectRoot, queue);
  manager.appendLedger('fleet_enqueued', { run_id: item.run_id, workflow_id: null, details: { queue_item_id: item.queue_item_id, requested_by: item.requested_by, priority: item.priority } });
  return { enqueued: true, project_root: projectRoot, queue_item: item };
}

export async function handleOrchFleetClaim(
  params: Parameters<typeof OrchFleetClaimSchema.parse>[0],
): Promise<unknown> {
  const parsed = OrchFleetClaimSchema.parse(params);
  const { manager, projectRoot } = createStateManager(parsed.project_root);
  const queue = requireValidQueue(projectRoot);
  const queuedItems = sortQueuedItems(queue.items.filter(item =>
    item.status === 'queued' && (!parsed.run_id || item.run_id === parsed.run_id)
  ));
  const target = queuedItems[0];
  if (!target) {
    return missingClaimResponse(projectRoot, parsed.run_id);
  }

  const claim: FleetQueueClaim = {
    claim_id: `fqc_${randomUUID()}`,
    owner_id: parsed.owner_id,
    claimed_at: utcNowIso(),
  };
  target.status = 'claimed';
  target.claim = claim;
  writeFleetQueue(projectRoot, queue);
  manager.appendLedger('fleet_claimed', { run_id: target.run_id, workflow_id: null, details: { queue_item_id: target.queue_item_id, owner_id: parsed.owner_id, claim_id: claim.claim_id } });
  return { claimed: true, project_root: projectRoot, queue_item: { ...target } };
}

export async function handleOrchFleetRelease(
  params: Parameters<typeof OrchFleetReleaseSchema.parse>[0],
): Promise<unknown> {
  const parsed = OrchFleetReleaseSchema.parse(params);
  const { manager, projectRoot } = createStateManager(parsed.project_root);
  const queue = requireValidQueue(projectRoot);
  const item = queue.items.find(entry => entry.queue_item_id === parsed.queue_item_id);
  if (!item) {
    throw notFound(`unknown queue_item_id '${parsed.queue_item_id}'`, { queue_item_id: parsed.queue_item_id, project_root: projectRoot });
  }
  if (item.status !== 'claimed' || !item.claim) {
    throw invalidParams(`queue item '${parsed.queue_item_id}' is not currently claimed`, { queue_item_id: parsed.queue_item_id, status: item.status });
  }
  if (item.claim.owner_id !== parsed.owner_id) {
    throw invalidParams(`queue item '${parsed.queue_item_id}' is owned by '${item.claim.owner_id}', not '${parsed.owner_id}'`, {
      queue_item_id: parsed.queue_item_id,
      owner_id: parsed.owner_id,
      current_owner_id: item.claim.owner_id,
    });
  }

  const disposition = parsed.disposition as FleetQueueDisposition;
  const nextItem = disposition === 'requeue'
    ? { ...clearClaim(item, 'queued'), attempt_count: item.attempt_count + 1 }
    : clearClaim(item, disposition);
  Object.assign(item, nextItem);
  delete item.claim;
  writeFleetQueue(projectRoot, queue);
  manager.appendLedger('fleet_released', { run_id: item.run_id, workflow_id: null, details: { queue_item_id: item.queue_item_id, owner_id: parsed.owner_id, disposition } });
  return { released: true, project_root: projectRoot, queue_item: { ...item } };
}
