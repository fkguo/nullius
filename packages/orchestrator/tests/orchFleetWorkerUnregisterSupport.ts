import type { FleetWorkerRecord } from '../src/orch-tools/fleet-worker-store.js';
import { baseState, writeLedger, writeState } from './orchFleetTestSupport.js';

const WORKER_TS = '2026-03-23T00:00:00Z';

export function writeInitializedProject(projectRoot: string, runId = 'run-1'): void {
  writeState(projectRoot, baseState({ run_id: runId }));
  writeLedger(projectRoot, [{
    ts: WORKER_TS,
    event_type: 'initialized',
    run_id: runId,
    workflow_id: 'runtime',
    step_id: null,
    details: {},
  }]);
}

export function fleetWorker(overrides: Partial<FleetWorkerRecord> = {}): FleetWorkerRecord {
  return {
    worker_id: 'worker-1',
    registered_at: WORKER_TS,
    last_heartbeat_at: WORKER_TS,
    accepts_claims: false,
    max_concurrent_claims: 1,
    heartbeat_timeout_seconds: 30,
    ...overrides,
  };
}

export function unregisterPayload(
  projectRoot: string,
  overrides: Partial<{
    worker_id: string;
    unregistered_by: string;
    note: string;
  }> = {},
) {
  return {
    project_root: projectRoot,
    worker_id: 'worker-1',
    unregistered_by: 'operator',
    note: 'drain complete',
    ...overrides,
  };
}
