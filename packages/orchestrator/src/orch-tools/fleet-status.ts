import * as fs from 'node:fs';
import * as path from 'node:path';
import { z } from 'zod';
import { createStateManager } from './common.js';
import { OrchFleetStatusSchema } from './schemas.js';
import {
  buildRunStatusView,
  readApprovalsView,
  readRunListView,
  type ReadModelError,
} from './run-read-model.js';
import { readFleetQueue, summarizeFleetQueue, type FleetQueueItem } from './fleet-queue-store.js';
import { readFleetWorkers, summarizeFleetWorkers, type FleetWorkersView } from './fleet-worker-store.js';
import {
  buildFleetQueueDiagnosticItems,
  summarizeFleetQueueAttention,
  type FleetQueueDiagnosticView,
} from './fleet-status-diagnostics.js';

type FleetProjectSnapshot = {
  project_root: string;
  control_dir: string;
  current_run: {
    run_id: string | null;
    run_status: string;
    workflow_id: string | null;
    current_step: unknown | null;
    pending_approval: unknown | null;
    is_paused: boolean;
    uri: string | null;
  } | null;
  runs: Array<{
    run_id: string;
    last_event: string;
    last_status: string;
    timestamp_utc: string;
    uri: string;
  }>;
  approvals: Array<Record<string, unknown>>;
  queue: FleetQueueDiagnosticView;
  workers: FleetWorkersView;
  errors: ReadModelError[];
};

function activeClaimsByWorker(queueItems: FleetQueueItem[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of queueItems) {
    if (item.status !== 'claimed') continue;
    const ownerId = item.claim?.owner_id;
    if (!ownerId) continue;
    counts[ownerId] = (counts[ownerId] ?? 0) + 1;
  }
  return counts;
}

function normalizeProjectRoots(projectRoots: string[]): string[] {
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const rawRoot of projectRoots) {
    const { projectRoot } = createStateManager(rawRoot);
    if (seen.has(projectRoot)) continue;
    seen.add(projectRoot);
    ordered.push(projectRoot);
  }
  return ordered;
}

function uniqueRunStatuses(project: FleetProjectSnapshot): string[] {
  const byRunId = new Map<string, string>();
  if (project.current_run?.run_id) {
    byRunId.set(project.current_run.run_id, project.current_run.run_status);
  }
  for (const run of project.runs) {
    if (!byRunId.has(run.run_id)) {
      byRunId.set(run.run_id, run.last_status);
    }
  }
  return [...byRunId.values()];
}

function readProjectSnapshot(
  projectRoot: string,
  params: z.output<typeof OrchFleetStatusSchema>,
): FleetProjectSnapshot {
  const { manager } = createStateManager(projectRoot);
  const errors: ReadModelError[] = [];
  let currentRun: FleetProjectSnapshot['current_run'] = null;
  let state: ReturnType<typeof manager.readState> | null = null;

  if (!fs.existsSync(manager.statePath)) {
    errors.push({ code: 'STATE_MISSING', message: `No state found at ${manager.statePath}.` });
  } else {
    try {
      state = manager.readState();
      const status = buildRunStatusView(projectRoot, state);
      currentRun = {
        run_id: status.run_id,
        run_status: status.run_status,
        workflow_id: status.workflow_id,
        current_step: status.current_step,
        pending_approval: status.pending_approval,
        is_paused: status.is_paused,
        uri: status.uri,
      };
    } catch {
      errors.push({ code: 'STATE_PARSE_ERROR', message: `Failed to parse ${manager.statePath}.` });
    }
  }

  const runList = readRunListView(manager, {
    limit: params.limit_per_project,
    status_filter: params.status_filter,
  });
  errors.push(...runList.errors);

  let approvals: Array<Record<string, unknown>> = [];
  if (state) {
    try {
      const approvalView = readApprovalsView(projectRoot, state, {
        gate_filter: 'all',
        include_history: params.include_history,
      });
      approvals = approvalView.approvals;
      errors.push(...approvalView.errors);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to read approvals.';
      errors.push({ code: 'APPROVAL_READ_ERROR', message });
    }
  }
  const queueRead = readFleetQueue(projectRoot);
  const workersRead = readFleetWorkers(projectRoot);
  errors.push(...queueRead.errors, ...workersRead.errors);
  const workers = summarizeFleetWorkers(
    workersRead,
    params.limit_per_project,
    activeClaimsByWorker(queueRead.queue?.items ?? []),
  );
  const queueView = summarizeFleetQueue(queueRead, params.limit_per_project);
  const diagnosticItems = buildFleetQueueDiagnosticItems(queueView.items, workers.workers, errors);
  const queue: FleetQueueDiagnosticView = {
    ...queueView,
    ...summarizeFleetQueueAttention(diagnosticItems),
    items: diagnosticItems,
  };

  return {
    project_root: projectRoot,
    control_dir: path.dirname(manager.statePath),
    current_run: currentRun,
    runs: runList.runs,
    approvals,
    queue,
    workers,
    errors,
  };
}

export async function handleOrchFleetStatus(
  params: z.output<typeof OrchFleetStatusSchema>,
): Promise<unknown> {
  const projects = normalizeProjectRoots(params.project_roots).map(projectRoot => readProjectSnapshot(projectRoot, params));
  const byStatus: Record<string, number> = {};
  let runCount = 0;
  let pendingApprovalCount = 0;
  let errorCount = 0;
  let workerCount = 0;
  let healthyWorkerCount = 0;
  let staleWorkerCount = 0;
  let totalWorkerSlots = 0;
  let claimedWorkerSlots = 0;
  let availableWorkerSlots = 0;
  let attentionClaimCount = 0;
  let claimedWithoutWorkerCount = 0;
  let claimedWithStaleWorkerCount = 0;
  let expiredClaimCount = 0;

  for (const project of projects) {
    for (const status of uniqueRunStatuses(project)) {
      byStatus[status] = (byStatus[status] ?? 0) + 1;
      runCount += 1;
    }
    pendingApprovalCount += project.approvals.filter(item => item.status === 'pending').length;
    errorCount += project.errors.length;
    workerCount += project.workers.total;
    healthyWorkerCount += project.workers.by_health.healthy;
    staleWorkerCount += project.workers.by_health.stale;
    totalWorkerSlots += project.workers.capacity.total_slots;
    claimedWorkerSlots += project.workers.capacity.claimed_slots;
    availableWorkerSlots += project.workers.capacity.available_slots;
    attentionClaimCount += project.queue.attention_claim_count;
    claimedWithoutWorkerCount += project.queue.claimed_without_worker_count;
    claimedWithStaleWorkerCount += project.queue.claimed_with_stale_worker_count;
    expiredClaimCount += project.queue.expired_claim_count;
  }

  return {
    summary: {
      project_count: projects.length,
      run_count: runCount,
      pending_approval_count: pendingApprovalCount,
      by_status: byStatus,
      error_count: errorCount,
      worker_count: workerCount,
      healthy_worker_count: healthyWorkerCount,
      stale_worker_count: staleWorkerCount,
      total_worker_slots: totalWorkerSlots,
      claimed_worker_slots: claimedWorkerSlots,
      available_worker_slots: availableWorkerSlots,
      attention_claim_count: attentionClaimCount,
      claimed_without_worker_count: claimedWithoutWorkerCount,
      claimed_with_stale_worker_count: claimedWithStaleWorkerCount,
      expired_claim_count: expiredClaimCount,
    },
    projects,
  };
}
