import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { StateManager, LedgerWriter, ApprovalGate, approvalPacketSha256 } from '../src/index.js';
import type { RunState } from '../src/index.js';

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'orch-test-'));
}

function writeState(repoRoot: string, state: RunState): void {
  const dir = path.join(repoRoot, '.autopilot');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(state, null, 2));
}

function writePolicy(repoRoot: string, policy: Record<string, unknown>): void {
  const dir = path.join(repoRoot, '.autopilot');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'approval_policy.json'), JSON.stringify(policy));
}

/** Minimal valid RunState for tests (Python SSOT shape). */
function baseState(overrides?: Partial<RunState>): RunState {
  return {
    schema_version: 1,
    run_id: null,
    workflow_id: null,
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

describe('StateManager', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns default state when no file exists', () => {
    const sm = new StateManager(tmpDir);
    const state = sm.readState();
    expect(state.schema_version).toBe(1);
    expect(state.run_status).toBe('idle');
    expect(state.run_id).toBeNull();
  });

  it('reads state from file (Python-shaped)', () => {
    const state = baseState({
      run_id: 'test-run-1',
      workflow_id: 'W_compute',
      run_status: 'running',
      current_step: { step_id: 'phase_1', title: 'Phase 1', started_at: '2026-02-24T00:00:00Z' },
    });
    writeState(tmpDir, state);

    const sm = new StateManager(tmpDir);
    const read = sm.readState();
    expect(read.run_id).toBe('test-run-1');
    expect(read.run_status).toBe('running');
    expect(read.current_step?.step_id).toBe('phase_1');
    expect(read.current_step?.started_at).toBe('2026-02-24T00:00:00Z');
  });

  it('reads awaiting_approval status (Python SSOT)', () => {
    const state = baseState({
      run_id: 'test-run-1',
      run_status: 'awaiting_approval',
      pending_approval: {
        approval_id: 'apr_test',
        category: 'A1',
        plan_step_ids: ['step_1'],
        requested_at: '2026-02-24T00:00:00Z',
        timeout_at: '2026-02-25T00:00:00Z',
        on_timeout: 'block',
        packet_path: 'artifacts/runs/test-run-1/approvals/apr_test/packet.md',
      },
    });
    writeState(tmpDir, state);

    const sm = new StateManager(tmpDir);
    const read = sm.readState();
    expect(read.run_status).toBe('awaiting_approval');
    expect(read.pending_approval?.packet_path).toContain('packet.md');
  });

  it('detects timed-out approval', () => {
    const state = baseState({
      run_id: 'test-run-1',
      run_status: 'awaiting_approval',
      pending_approval: {
        approval_id: 'apr_test',
        category: 'A1',
        plan_step_ids: [],
        requested_at: '2020-01-01T00:00:00Z',
        timeout_at: '2020-01-01T01:00:00Z', // long past
        on_timeout: 'block',
        packet_path: 'approvals/apr_test/packet.md',
      },
    });

    const sm = new StateManager(tmpDir);
    expect(sm.isApprovalTimedOut(state)).toBe(true);
  });

  it('detects exhausted approval budget (budgets.max_approvals path)', () => {
    // Python reads policy.budgets.max_approvals
    writePolicy(tmpDir, { budgets: { max_approvals: 2 } });

    const state = baseState({
      run_id: 'test-run-1',
      run_status: 'running',
      approval_history: [
        { ts: '2020-01-01T00:00:00Z', approval_id: 'a1', category: 'A1', decision: 'approved', note: '' },
        { ts: '2020-01-01T01:00:00Z', approval_id: 'a2', category: 'A2', decision: 'approved', note: '' },
      ],
    });

    const sm = new StateManager(tmpDir);
    expect(sm.isApprovalBudgetExhausted(state)).toBe(true);
  });

  it('gate_satisfied accepts string values (Python writes approval_id)', () => {
    const state = baseState({
      gate_satisfied: { 'A1': 'apr_001' } as Record<string, string | boolean>,
    });
    writeState(tmpDir, state);
    const sm = new StateManager(tmpDir);
    const read = sm.readState();
    expect(read.gate_satisfied['A1']).toBe('apr_001');
  });
});

describe('LedgerWriter', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates ledger file and appends events with sorted keys', () => {
    const lw = new LedgerWriter(tmpDir);
    lw.log('test_event', { details: { key: 'value', nested: { b: 2, a: 1 } } });
    lw.log('test_event_2');

    const events = lw.tail(10);
    expect(events).toHaveLength(2);
    expect(events[0]!.event_type).toBe('test_event');
    expect(events[1]!.event_type).toBe('test_event_2');
  });

  it('preserves nested details (no data loss from replacer)', () => {
    const lw = new LedgerWriter(tmpDir);
    lw.log('approval_timeout', {
      details: { approval_id: 'apr_001', policy_action: 'block', timeout_at: '2026-01-01T00:00:00Z' },
    });

    const events = lw.tail(1);
    expect(events[0]!.details).toEqual({
      approval_id: 'apr_001',
      policy_action: 'block',
      timeout_at: '2026-01-01T00:00:00Z',
    });
  });

  it('sorts keys recursively (Python parity)', () => {
    const lw = new LedgerWriter(tmpDir);
    lw.log('test', { details: { z_key: 1, a_key: 2 } });

    // Read raw line to verify sort order
    const dir = path.join(tmpDir, '.autopilot');
    const raw = fs.readFileSync(path.join(dir, 'ledger.jsonl'), 'utf-8').trim();
    const parsed = JSON.parse(raw);
    const keys = Object.keys(parsed);
    // Verify top-level keys are sorted
    expect(keys).toEqual([...keys].sort());
    // Verify details keys are sorted
    const detailKeys = Object.keys(parsed.details);
    expect(detailKeys).toEqual([...detailKeys].sort());
  });

  it('tail returns last N events', () => {
    const lw = new LedgerWriter(tmpDir);
    for (let i = 0; i < 10; i++) {
      lw.log(`event_${i}`);
    }

    const events = lw.tail(3);
    expect(events).toHaveLength(3);
    expect(events[0]!.event_type).toBe('event_7');
  });
});

describe('ApprovalGate', () => {
  it('creates pending approval with Python-shaped fields', () => {
    const gate = new ApprovalGate({
      timeouts: { A1: { timeout_seconds: 3600, on_timeout: 'reject' } },
    });
    const pending = gate.createPending({
      category: 'A1',
      plan_step_ids: ['step_1'],
      packet_path: 'approvals/apr_test/packet.md',
    });

    expect(pending.category).toBe('A1');
    expect(pending.plan_step_ids).toEqual(['step_1']);
    expect(pending.packet_path).toBe('approvals/apr_test/packet.md');
    expect(pending.on_timeout).toBe('reject');
    expect(pending.approval_id).toMatch(/^apr_/);
  });

  it('rejects approval with wrong ID', () => {
    const gate = new ApprovalGate({});
    const state = baseState({
      run_id: 'r1',
      run_status: 'awaiting_approval',
      pending_approval: {
        approval_id: 'apr_correct',
        category: 'A1',
        plan_step_ids: [],
        requested_at: '2020-01-01T00:00:00Z',
        timeout_at: '2099-01-01T00:00:00Z',
        on_timeout: 'block',
        packet_path: 'approvals/apr_correct/packet.md',
      },
    });

    const result = gate.checkApproval(state, 'apr_wrong');
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('mismatch');
  });

  it('rejects timed-out approval', () => {
    const gate = new ApprovalGate({});
    const state = baseState({
      run_id: 'r1',
      run_status: 'awaiting_approval',
      pending_approval: {
        approval_id: 'apr_test',
        category: 'A1',
        plan_step_ids: [],
        requested_at: '2020-01-01T00:00:00Z',
        timeout_at: '2020-01-01T01:00:00Z', // expired
        on_timeout: 'reject',
        packet_path: 'approvals/apr_test/packet.md',
      },
    });

    const result = gate.checkApproval(state, 'apr_test');
    expect(result.allowed).toBe(false);
    expect(result.action).toBe('reject');
  });

  it('enforces approval budget (budgets.max_approvals)', () => {
    const gate = new ApprovalGate({ budgets: { max_approvals: 1 } });
    const state = baseState({
      run_id: 'r1',
      run_status: 'awaiting_approval',
      pending_approval: {
        approval_id: 'apr_test',
        category: 'A1',
        plan_step_ids: [],
        requested_at: '2020-01-01T00:00:00Z',
        timeout_at: '2099-01-01T00:00:00Z',
        on_timeout: 'block',
        packet_path: 'approvals/apr_test/packet.md',
      },
      approval_history: [
        { ts: '2020-01-01T00:00:00Z', approval_id: 'a1', category: 'A1', decision: 'approved', note: '' },
      ],
    });

    const result = gate.checkApproval(state, 'apr_test');
    expect(result.allowed).toBe(false);
    expect(result.action).toBe('budget_exhausted');
  });

  it('allows valid approval', () => {
    const gate = new ApprovalGate({});
    const state = baseState({
      run_id: 'r1',
      run_status: 'awaiting_approval',
      pending_approval: {
        approval_id: 'apr_ok',
        category: 'A1',
        plan_step_ids: [],
        requested_at: '2020-01-01T00:00:00Z',
        timeout_at: '2099-01-01T00:00:00Z',
        on_timeout: 'block',
        packet_path: 'approvals/apr_ok/packet.md',
      },
    });

    const result = gate.checkApproval(state, 'apr_ok');
    expect(result.allowed).toBe(true);
  });
});

describe('approvalPacketSha256', () => {
  it('produces consistent hash for same content (key-order independent)', () => {
    const hash1 = approvalPacketSha256({ a: 1, b: 2 });
    const hash2 = approvalPacketSha256({ b: 2, a: 1 });
    expect(hash1).toBe(hash2);
  });

  it('sorts nested keys recursively', () => {
    const hash1 = approvalPacketSha256({ outer: { z: 1, a: 2 } });
    const hash2 = approvalPacketSha256({ outer: { a: 2, z: 1 } });
    expect(hash1).toBe(hash2);
  });
});
