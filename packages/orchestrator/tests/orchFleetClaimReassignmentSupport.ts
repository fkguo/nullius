import {
  baseState,
  buildLeaseClaim,
  writeLedger,
  writeState,
} from './orchFleetTestSupport.js';

export function writeInitializedProject(projectRoot: string, runId = 'run-1'): void {
  writeState(projectRoot, baseState({ run_id: runId }));
  writeLedger(projectRoot, [{
    ts: '2026-03-28T00:00:00Z',
    event_type: 'initialized',
    run_id: runId,
    workflow_id: 'runtime',
    step_id: null,
    details: {},
  }]);
}

export function fleetWorker(overrides: Record<string, unknown> = {}) {
  return {
    worker_id: 'worker-1',
    registered_at: '2026-03-28T00:00:00Z',
    last_heartbeat_at: '2026-03-28T00:00:00Z',
    accepts_claims: true,
    max_concurrent_claims: 2,
    heartbeat_timeout_seconds: 60,
    ...overrides,
  };
}

export function claimedQueueItem(overrides: Record<string, unknown> = {}) {
  return {
    queue_item_id: 'fq_claimed',
    run_id: 'run-1',
    status: 'claimed',
    priority: 1,
    enqueued_at: '2026-03-28T00:00:00Z',
    requested_by: 'operator',
    attempt_count: 0,
    claim: buildLeaseClaim({ claim_id: 'claim-1', owner_id: 'worker-1' }),
    ...overrides,
  };
}
