import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { invalidParams, notFound, type FleetQueueV1 } from '@autoresearch/shared';
import { utcNowIso } from '../util.js';
import { createStateManager } from './common.js';
import { readRunListView, type ReadModelError } from './run-read-model.js';
import {
  createEmptyFleetQueue,
  readFleetQueue,
  writeFleetQueue,
  type FleetQueueClaim,
  type FleetQueueItem,
} from './fleet-queue-store.js';
import { buildFleetLeaseClaim } from './fleet-lease.js';
import {
  OrchFleetAdjudicateStaleClaimSchema,
  OrchFleetClaimSchema,
  OrchFleetEnqueueSchema,
  OrchFleetReleaseSchema,
} from './schemas.js';

type FleetQueueDisposition = 'requeue' | 'completed' | 'failed' | 'cancelled';
type CanonicalRunEvidence = {
  state: { current_run_id: string | null; matched: boolean };
  ledger: { ledger_path: string; matched: boolean; diagnostics: ReadModelError[] };
  artifacts: { run_dir: string; matched: boolean; diagnostics: ReadModelError[] };
};

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

function scanLedgerForRunId(ledgerPath: string, runId: string): { matched: boolean; diagnostics: ReadModelError[] } {
  if (!fs.existsSync(ledgerPath)) {
    return {
      matched: false,
      diagnostics: [{ code: 'LEDGER_MISSING', message: `No ledger found at ${ledgerPath}.` }],
    };
  }
  let invalidLines = 0;
  try {
    const lines = fs.readFileSync(ledgerPath, 'utf-8').split('\n').filter(line => line.trim());
    for (const line of lines) {
      try {
        const event = JSON.parse(line) as Record<string, unknown>;
        if (typeof event.run_id === 'string' && event.run_id === runId) {
          return { matched: true, diagnostics: [] };
        }
      } catch {
        invalidLines += 1;
      }
    }
  } catch {
    return {
      matched: false,
      diagnostics: [{ code: 'LEDGER_READ_ERROR', message: `Failed to read ${ledgerPath}.` }],
    };
  }
  const diagnostics: ReadModelError[] = [];
  if (invalidLines > 0) {
    diagnostics.push({
      code: 'LEDGER_PARSE_ERROR',
      message: `Skipped ${invalidLines} invalid ledger line(s) in ${ledgerPath}.`,
    });
  }
  return { matched: false, diagnostics };
}

function detectArtifactsRunDir(projectRoot: string, runId: string): {
  runDir: string;
  matched: boolean;
  diagnostics: ReadModelError[];
} {
  const runDir = path.join(projectRoot, 'artifacts', 'runs', runId);
  if (!fs.existsSync(runDir)) {
    return { runDir, matched: false, diagnostics: [] };
  }
  try {
    const matched = fs.statSync(runDir).isDirectory();
    return {
      runDir,
      matched,
      diagnostics: matched
        ? []
        : [{ code: 'RUN_ARTIFACT_NOT_DIRECTORY', message: `${runDir} exists but is not a directory.` }],
    };
  } catch {
    return {
      runDir,
      matched: false,
      diagnostics: [{ code: 'RUN_ARTIFACT_READ_ERROR', message: `Failed to inspect ${runDir}.` }],
    };
  }
}

function assertKnownRun(projectRoot: string, runId: string): void {
  const { manager } = createStateManager(projectRoot);
  const state = manager.readState();
  const stateMatched = state.run_id === runId;
  if (stateMatched) {
    return;
  }
  const ledger = scanLedgerForRunId(manager.ledgerPath, runId);
  if (ledger.matched) {
    return;
  }
  const artifacts = detectArtifactsRunDir(projectRoot, runId);
  if (artifacts.matched) {
    return;
  }
  // Keep read-model diagnostics for observability, but do not use projection data for mutation gating.
  const runList = readRunListView(manager, { limit: 1, status_filter: 'all' });
  const canonicalEvidence: CanonicalRunEvidence = {
    state: {
      current_run_id: state.run_id ?? null,
      matched: stateMatched,
    },
    ledger: {
      ledger_path: manager.ledgerPath,
      matched: ledger.matched,
      diagnostics: ledger.diagnostics,
    },
    artifacts: {
      run_dir: artifacts.runDir,
      matched: artifacts.matched,
      diagnostics: artifacts.diagnostics,
    },
  };
  throw invalidParams(`unknown run_id '${runId}' for ${projectRoot}`, {
    run_id: runId,
    project_root: projectRoot,
    projection_not_authoritative: true,
    canonical_evidence: canonicalEvidence,
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

function requireClaimedItem(queue: FleetQueueV1, queueItemId: string, projectRoot: string): FleetQueueItem {
  const item = queue.items.find(entry => entry.queue_item_id === queueItemId);
  if (!item) {
    throw notFound(`unknown queue_item_id '${queueItemId}'`, { queue_item_id: queueItemId, project_root: projectRoot });
  }
  if (item.status !== 'claimed' || !item.claim) {
    throw invalidParams(`queue item '${queueItemId}' is not currently claimed`, {
      queue_item_id: queueItemId,
      status: item.status,
      project_root: projectRoot,
    });
  }
  return item;
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

  const claim: FleetQueueClaim = buildFleetLeaseClaim({
    claim_id: `fqc_${randomUUID()}`,
    owner_id: parsed.owner_id,
    claimed_at: utcNowIso(),
    lease_duration_seconds: parsed.lease_duration_seconds,
  });
  target.status = 'claimed';
  target.claim = claim;
  writeFleetQueue(projectRoot, queue);
  manager.appendLedger('fleet_claimed', {
    run_id: target.run_id,
    workflow_id: null,
    details: {
      queue_item_id: target.queue_item_id,
      owner_id: parsed.owner_id,
      claim_id: claim.claim_id,
      lease_duration_seconds: claim.lease_duration_seconds,
      lease_expires_at: claim.lease_expires_at,
    },
  });
  return { claimed: true, project_root: projectRoot, queue_item: { ...target } };
}

export async function handleOrchFleetRelease(
  params: Parameters<typeof OrchFleetReleaseSchema.parse>[0],
): Promise<unknown> {
  const parsed = OrchFleetReleaseSchema.parse(params);
  const { manager, projectRoot } = createStateManager(parsed.project_root);
  const queue = requireValidQueue(projectRoot);
  const item = requireClaimedItem(queue, parsed.queue_item_id, projectRoot);
  const claim = item.claim;
  if (!claim) {
    throw invalidParams(`queue item '${parsed.queue_item_id}' is missing claim metadata`, {
      queue_item_id: parsed.queue_item_id,
      project_root: projectRoot,
    });
  }
  if (claim.owner_id !== parsed.owner_id) {
    throw invalidParams(`queue item '${parsed.queue_item_id}' is owned by '${claim.owner_id}', not '${parsed.owner_id}'`, {
      queue_item_id: parsed.queue_item_id,
      owner_id: parsed.owner_id,
      current_owner_id: claim.owner_id,
    });
  }

  const disposition = parsed.disposition as FleetQueueDisposition;
  const nextItem = disposition === 'requeue'
    ? { ...clearClaim(item, 'queued'), attempt_count: item.attempt_count + 1 }
    : clearClaim(item, disposition);
  Object.assign(item, nextItem);
  delete item.claim;
  writeFleetQueue(projectRoot, queue);
  manager.appendLedger('fleet_released', {
    run_id: item.run_id,
    workflow_id: null,
    details: {
      queue_item_id: item.queue_item_id,
      owner_id: parsed.owner_id,
      disposition,
      prior_claim_id: claim.claim_id,
      prior_lease_expires_at: claim.lease_expires_at,
      lease_duration_seconds: claim.lease_duration_seconds,
    },
  });
  return { released: true, project_root: projectRoot, queue_item: { ...item } };
}

export async function handleOrchFleetAdjudicateStaleClaim(
  params: Parameters<typeof OrchFleetAdjudicateStaleClaimSchema.parse>[0],
): Promise<unknown> {
  const parsed = OrchFleetAdjudicateStaleClaimSchema.parse(params);
  const { manager, projectRoot } = createStateManager(parsed.project_root);
  const queue = requireValidQueue(projectRoot);
  const item = requireClaimedItem(queue, parsed.queue_item_id, projectRoot);
  const claim = item.claim;
  if (!claim) {
    throw invalidParams(`queue item '${parsed.queue_item_id}' is missing claim metadata`, {
      queue_item_id: parsed.queue_item_id,
      project_root: projectRoot,
    });
  }

  if (claim.claim_id !== parsed.expected_claim_id) {
    throw invalidParams(`queue item '${parsed.queue_item_id}' claim_id changed since the operator inspected it`, {
      queue_item_id: parsed.queue_item_id,
      expected_claim_id: parsed.expected_claim_id,
      current_claim_id: claim.claim_id,
      project_root: projectRoot,
    });
  }
  if (claim.owner_id !== parsed.expected_owner_id) {
    throw invalidParams(`queue item '${parsed.queue_item_id}' owner changed since the operator inspected it`, {
      queue_item_id: parsed.queue_item_id,
      expected_owner_id: parsed.expected_owner_id,
      current_owner_id: claim.owner_id,
      project_root: projectRoot,
    });
  }

  const priorClaimId = claim.claim_id;
  const priorOwnerId = claim.owner_id;
  const nextItem = parsed.disposition === 'requeue'
    ? { ...clearClaim(item, 'queued'), attempt_count: item.attempt_count + 1 }
    : clearClaim(item, parsed.disposition);
  Object.assign(item, nextItem);
  delete item.claim;
  writeFleetQueue(projectRoot, queue);
  manager.appendLedger('fleet_claim_adjudicated', {
    run_id: item.run_id,
    workflow_id: null,
    details: {
      queue_item_id: item.queue_item_id,
      prior_claim_id: priorClaimId,
      prior_owner_id: priorOwnerId,
      prior_lease_expires_at: claim.lease_expires_at,
      lease_duration_seconds: claim.lease_duration_seconds,
      adjudicated_by: parsed.adjudicated_by,
      disposition: parsed.disposition,
      note: parsed.note,
    },
  });
  return {
    adjudicated: true,
    project_root: projectRoot,
    queue_item: { ...item },
  };
}
