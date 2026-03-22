import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { RunState } from '../src/index.js';

let tmpDirs: string[] = [];

function controlDir(projectRoot: string): string {
  return path.join(projectRoot, '.autoresearch');
}

export function makeTmpDir(prefix = 'orch-fleet-', parent = os.tmpdir()): string {
  const dir = fs.mkdtempSync(path.join(parent, prefix));
  tmpDirs.push(dir);
  return dir;
}

export function cleanupTmpDirs(): void {
  for (const dir of tmpDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  tmpDirs = [];
}

export function baseState(overrides: Partial<RunState> = {}): RunState {
  return {
    schema_version: 1,
    run_id: 'run-1',
    workflow_id: 'runtime',
    run_status: 'idle',
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
    ...overrides,
  };
}

export function writeState(projectRoot: string, state: RunState): void {
  fs.mkdirSync(controlDir(projectRoot), { recursive: true });
  fs.writeFileSync(path.join(controlDir(projectRoot), 'state.json'), JSON.stringify(state, null, 2) + '\n', 'utf-8');
}

export function writeLedger(projectRoot: string, events: Array<Record<string, unknown> | string>): void {
  fs.mkdirSync(controlDir(projectRoot), { recursive: true });
  const content = events.map(event => typeof event === 'string' ? event : JSON.stringify(event)).join('\n');
  fs.writeFileSync(path.join(controlDir(projectRoot), 'ledger.jsonl'), `${content}\n`, 'utf-8');
}

export function writeApprovalPacket(projectRoot: string, runId: string, approvalId: string): void {
  const approvalDir = path.join(projectRoot, 'artifacts', 'runs', runId, 'approvals', approvalId);
  fs.mkdirSync(approvalDir, { recursive: true });
  fs.writeFileSync(path.join(approvalDir, 'approval_packet_v1.json'), JSON.stringify({
    approval_id: approvalId,
    gate_id: 'A1',
    requested_at: '2026-03-22T00:01:00Z',
  }, null, 2) + '\n', 'utf-8');
}

export function writeQueue(projectRoot: string, content: unknown): void {
  fs.mkdirSync(controlDir(projectRoot), { recursive: true });
  const payload = typeof content === 'string' ? content : JSON.stringify(content, null, 2) + '\n';
  fs.writeFileSync(path.join(controlDir(projectRoot), 'fleet_queue.json'), payload, 'utf-8');
}

export function writeWorkers(projectRoot: string, content: unknown): void {
  fs.mkdirSync(controlDir(projectRoot), { recursive: true });
  const payload = typeof content === 'string' ? content : JSON.stringify(content, null, 2) + '\n';
  fs.writeFileSync(path.join(controlDir(projectRoot), 'fleet_workers.json'), payload, 'utf-8');
}

function addSecondsToIso(baseIso: string, seconds: number): string {
  return new Date(Date.parse(baseIso) + (seconds * 1000)).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export function buildLeaseClaim(overrides: {
  claim_id?: string;
  owner_id?: string;
  claimed_at?: string;
  lease_duration_seconds?: number;
  lease_expires_at?: string;
} = {}) {
  const claimedAt = overrides.claimed_at ?? '2026-03-22T00:00:00Z';
  const leaseDurationSeconds = overrides.lease_duration_seconds ?? 60;
  return {
    claim_id: overrides.claim_id ?? 'claim-1',
    owner_id: overrides.owner_id ?? 'worker-1',
    claimed_at: claimedAt,
    lease_duration_seconds: leaseDurationSeconds,
    lease_expires_at: overrides.lease_expires_at ?? addSecondsToIso(claimedAt, leaseDurationSeconds),
  };
}
