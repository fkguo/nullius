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
  const dir = path.join(repoRoot, '.autoresearch');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(state, null, 2));
}

function writePolicy(repoRoot: string, policy: Record<string, unknown>): void {
  const dir = path.join(repoRoot, '.autoresearch');
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
    const dir = path.join(tmpDir, '.autoresearch');
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

// ─── Stage 2: Write operations ───

describe('StateManager write operations (Stage 2)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('saveState writes state.json atomically with sorted keys', () => {
    const sm = new StateManager(tmpDir);
    const state = baseState({ run_id: 'r1', run_status: 'idle' });
    sm.saveState(state);

    const raw = fs.readFileSync(path.join(tmpDir, '.autoresearch', 'state.json'), 'utf-8');
    const parsed = JSON.parse(raw);
    expect(parsed.run_id).toBe('r1');
    // Verify keys are sorted (Python parity: json.dumps(sort_keys=True))
    const keys = Object.keys(parsed);
    expect(keys).toEqual([...keys].sort());
    // Verify trailing newline (Python parity)
    expect(raw.endsWith('\n')).toBe(true);
  });

  it('saveState no .tmp file left after write', () => {
    const sm = new StateManager(tmpDir);
    sm.saveState(baseState());

    const dir = path.join(tmpDir, '.autoresearch');
    const files = fs.readdirSync(dir);
    expect(files.filter(f => f.endsWith('.tmp'))).toHaveLength(0);
  });

  it('ensureDirs creates directory and empty ledger', () => {
    const sm = new StateManager(tmpDir);
    sm.ensureDirs();

    const dir = path.join(tmpDir, '.autoresearch');
    expect(fs.existsSync(dir)).toBe(true);
    expect(fs.existsSync(path.join(dir, 'ledger.jsonl'))).toBe(true);
    expect(fs.readFileSync(path.join(dir, 'ledger.jsonl'), 'utf-8')).toBe('');
  });

  it('appendLedger writes sorted-key JSONL line', () => {
    const sm = new StateManager(tmpDir);
    sm.appendLedger('test_event', {
      run_id: 'r1',
      details: { z_key: 1, a_key: 2 },
    });

    const raw = fs.readFileSync(sm.ledgerPath, 'utf-8').trim();
    const parsed = JSON.parse(raw);
    expect(parsed.event_type).toBe('test_event');
    expect(parsed.run_id).toBe('r1');
    // Sorted keys
    const keys = Object.keys(parsed);
    expect(keys).toEqual([...keys].sort());
  });

  it('saveStateWithLedger stages .next then commits', () => {
    const sm = new StateManager(tmpDir);
    const state = baseState({ run_id: 'r1', run_status: 'running' });
    sm.saveStateWithLedger(state, 'test_persist', {
      details: { key: 'value' },
    });

    // State written
    const readState = sm.readState();
    expect(readState.run_id).toBe('r1');

    // Ledger has entry
    const raw = fs.readFileSync(sm.ledgerPath, 'utf-8').trim();
    const event = JSON.parse(raw);
    expect(event.event_type).toBe('test_persist');

    // No staged files left
    const files = fs.readdirSync(path.join(tmpDir, '.autoresearch'));
    expect(files.filter(f => f.includes('.next'))).toHaveLength(0);
  });

  it('transitionStatus enforces valid transitions', () => {
    const sm = new StateManager(tmpDir);
    const state = baseState({ run_id: 'r1', run_status: 'idle' });

    // idle → running: allowed
    sm.transitionStatus(state, 'running');
    expect(state.run_status).toBe('running');

    // running → completed: allowed
    sm.transitionStatus(state, 'completed');
    expect(state.run_status).toBe('completed');

    // completed → running: NOT allowed (terminal)
    expect(() => sm.transitionStatus(state, 'running')).toThrow('invalid status transition');
  });

  it('transitionStatus writes state + ledger', () => {
    const sm = new StateManager(tmpDir);
    const state = baseState({ run_id: 'r1', run_status: 'idle' });
    sm.transitionStatus(state, 'running', { notes: 'started' });

    const readState = sm.readState();
    expect(readState.run_status).toBe('running');
    expect(readState.notes).toBe('started');

    const raw = fs.readFileSync(sm.ledgerPath, 'utf-8').trim();
    const event = JSON.parse(raw);
    expect(event.event_type).toBe('status_running');
    expect(event.details.from).toBe('idle');
    expect(event.details.to).toBe('running');
  });

  it('createRun transitions idle → running with run_id', () => {
    const sm = new StateManager(tmpDir);
    const state = baseState();
    sm.createRun(state, 'test-run-001', 'W_compute');

    expect(state.run_id).toBe('test-run-001');
    expect(state.workflow_id).toBe('W_compute');
    expect(state.run_status).toBe('running');

    const readState = sm.readState();
    expect(readState.run_id).toBe('test-run-001');
  });

  it('createRun rejects non-idle state', () => {
    const sm = new StateManager(tmpDir);
    const state = baseState({ run_status: 'running' as RunState['run_status'] });
    expect(() => sm.createRun(state, 'r1', 'w1')).toThrow("expected 'idle'");
  });

  it('approveRun clears pending and resumes', () => {
    const sm = new StateManager(tmpDir);
    const state = baseState({
      run_id: 'r1',
      workflow_id: 'w1',
      run_status: 'awaiting_approval',
      pending_approval: {
        approval_id: 'A1-0001',
        category: 'A1',
        plan_step_ids: ['s1'],
        requested_at: '2026-02-24T00:00:00Z',
        timeout_at: '2099-01-01T00:00:00Z',
        on_timeout: 'block',
        packet_path: 'approvals/A1-0001/packet.md',
      },
    });

    sm.approveRun(state, 'A1-0001', 'looks good');

    expect(state.run_status).toBe('running');
    expect(state.pending_approval).toBeNull();
    expect(state.approval_history).toHaveLength(1);
    expect(state.approval_history[0]!.decision).toBe('approved');
    expect(state.approval_history[0]!.note).toBe('looks good');
    expect(state.gate_satisfied['A1']).toBe('A1-0001');
  });

  it('approveRun rejects wrong approval_id', () => {
    const sm = new StateManager(tmpDir);
    const state = baseState({
      run_id: 'r1',
      run_status: 'awaiting_approval',
      pending_approval: {
        approval_id: 'A1-0001',
        category: 'A1',
        plan_step_ids: [],
        requested_at: '2026-02-24T00:00:00Z',
        timeout_at: '2099-01-01T00:00:00Z',
        on_timeout: 'block',
        packet_path: 'approvals/A1-0001/packet.md',
      },
    });

    expect(() => sm.approveRun(state, 'A1-9999')).toThrow('approval_id mismatch');
  });

  it('rejectRun transitions to paused (matching Python cmd_reject)', () => {
    const sm = new StateManager(tmpDir);
    const state = baseState({
      run_id: 'r1',
      workflow_id: 'w1',
      run_status: 'awaiting_approval',
      pending_approval: {
        approval_id: 'A1-0001',
        category: 'A1',
        plan_step_ids: [],
        requested_at: '2026-02-24T00:00:00Z',
        timeout_at: '2099-01-01T00:00:00Z',
        on_timeout: 'block',
        packet_path: 'approvals/A1-0001/packet.md',
      },
    });

    sm.rejectRun(state, 'A1-0001', 'not ready');

    expect(state.run_status).toBe('paused');
    expect(state.pending_approval).toBeNull();
    expect(state.approval_history[0]!.decision).toBe('rejected');
  });

  it('pauseRun transitions running → paused', () => {
    const sm = new StateManager(tmpDir);
    const state = baseState({ run_id: 'r1', run_status: 'running' });
    sm.pauseRun(state);

    expect(state.run_status).toBe('paused');
    const readState = sm.readState();
    expect(readState.run_status).toBe('paused');
  });

  it('resumeRun transitions paused → running', () => {
    const sm = new StateManager(tmpDir);
    const state = baseState({ run_id: 'r1', run_status: 'paused' });
    sm.resumeRun(state);

    expect(state.run_status).toBe('running');
  });

  it('resumeRun transitions blocked → running', () => {
    const sm = new StateManager(tmpDir);
    const state = baseState({ run_id: 'r1', run_status: 'blocked' });
    sm.resumeRun(state);

    expect(state.run_status).toBe('running');
  });

  it('pauseRun rejects when awaiting_approval (B7 fix)', () => {
    const sm = new StateManager(tmpDir);
    const state = baseState({
      run_id: 'r1',
      run_status: 'awaiting_approval',
      pending_approval: {
        approval_id: 'A1-0001',
        category: 'A1',
        plan_step_ids: [],
        requested_at: '2026-02-24T00:00:00Z',
        timeout_at: '2099-01-01T00:00:00Z',
        on_timeout: 'block',
        packet_path: 'approvals/A1-0001/packet.md',
      },
    });
    expect(() => sm.pauseRun(state)).toThrow(/awaiting_approval/);
    expect(state.run_status).toBe('awaiting_approval'); // unchanged
  });

  it('resumeRun rejects when pending_approval exists (B6 fix)', () => {
    const sm = new StateManager(tmpDir);
    const state = baseState({
      run_id: 'r1',
      run_status: 'paused',
      pending_approval: {
        approval_id: 'A1-0001',
        category: 'A1',
        plan_step_ids: [],
        requested_at: '2026-02-24T00:00:00Z',
        timeout_at: '2099-01-01T00:00:00Z',
        on_timeout: 'block',
        packet_path: 'approvals/A1-0001/packet.md',
      },
    });
    expect(() => sm.resumeRun(state)).toThrow(/pending_approval/);
    expect(state.run_status).toBe('paused'); // unchanged
  });

  it('nextApprovalId generates sequential IDs', () => {
    const sm = new StateManager(tmpDir);
    const state = baseState();
    expect(sm.nextApprovalId(state, 'A1')).toBe('A1-0001');
    expect(sm.nextApprovalId(state, 'A1')).toBe('A1-0002');
    expect(sm.nextApprovalId(state, 'A3')).toBe('A3-0001');
    expect(state.approval_seq['A1']).toBe(2);
    expect(state.approval_seq['A3']).toBe(1);
  });

  it('full lifecycle: create → pause → resume → approve → complete', () => {
    const sm = new StateManager(tmpDir);
    const state = baseState();

    // Create
    sm.createRun(state, 'lifecycle-001', 'W_ingest');
    expect(state.run_status).toBe('running');

    // Pause
    sm.pauseRun(state);
    expect(state.run_status).toBe('paused');

    // Resume
    sm.resumeRun(state);
    expect(state.run_status).toBe('running');

    // Await approval
    const approvalId = sm.nextApprovalId(state, 'A1');
    state.pending_approval = {
      approval_id: approvalId,
      category: 'A1',
      plan_step_ids: ['s1'],
      requested_at: '2026-02-24T00:00:00Z',
      timeout_at: '2099-01-01T00:00:00Z',
      on_timeout: 'block',
      packet_path: `approvals/${approvalId}/packet.md`,
    };
    sm.transitionStatus(state, 'awaiting_approval');
    expect(state.run_status).toBe('awaiting_approval');

    // Approve
    sm.approveRun(state, approvalId);
    expect(state.run_status).toBe('running');

    // Complete
    sm.transitionStatus(state, 'completed');
    expect(state.run_status).toBe('completed');

    // Verify final persisted state
    const finalState = sm.readState();
    expect(finalState.run_status).toBe('completed');
    expect(finalState.approval_history).toHaveLength(1);

    // Verify ledger has multiple events
    const raw = fs.readFileSync(sm.ledgerPath, 'utf-8').trim().split('\n');
    expect(raw.length).toBeGreaterThanOrEqual(6); // create, pause, resume, await, approve, complete
  });
});

// ─── Stage 3a: Checkpoint + requestApproval + ledger parity ───

describe('Checkpoint management (Stage 3a)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('updateCheckpoint sets last_checkpoint_at and persists', () => {
    const sm = new StateManager(tmpDir);
    const state = baseState({ run_id: 'r1', run_status: 'running' });
    sm.saveState(state);

    expect(state.checkpoints.last_checkpoint_at).toBeNull();
    sm.updateCheckpoint(state);

    expect(state.checkpoints.last_checkpoint_at).toBeTruthy();
    // Verify persisted
    const readState = sm.readState();
    expect(readState.checkpoints.last_checkpoint_at).toBe(state.checkpoints.last_checkpoint_at);
  });

  it('isCheckpointDue returns false when no last_checkpoint_at', () => {
    const sm = new StateManager(tmpDir);
    const state = baseState();
    expect(sm.isCheckpointDue(state)).toBe(false);
  });

  it('isCheckpointDue returns false when interval is 0', () => {
    const sm = new StateManager(tmpDir);
    const state = baseState({
      checkpoints: { last_checkpoint_at: '2020-01-01T00:00:00Z', checkpoint_interval_seconds: 0 },
    });
    expect(sm.isCheckpointDue(state)).toBe(false);
  });

  it('isCheckpointDue returns true when elapsed > interval', () => {
    const sm = new StateManager(tmpDir);
    const state = baseState({
      checkpoints: { last_checkpoint_at: '2020-01-01T00:00:00Z', checkpoint_interval_seconds: 900 },
    });
    expect(sm.isCheckpointDue(state)).toBe(true); // long past
  });

  it('isCheckpointDue returns false when checkpoint is recent', () => {
    const sm = new StateManager(tmpDir);
    const state = baseState({
      checkpoints: { last_checkpoint_at: new Date().toISOString(), checkpoint_interval_seconds: 900 },
    });
    expect(sm.isCheckpointDue(state)).toBe(false);
  });

  it('approveRun updates checkpoint timestamp (deferral fix)', () => {
    const sm = new StateManager(tmpDir);
    const state = baseState({
      run_id: 'r1',
      workflow_id: 'w1',
      run_status: 'awaiting_approval',
      pending_approval: {
        approval_id: 'A1-0001',
        category: 'A1',
        plan_step_ids: ['s1'],
        requested_at: '2026-02-24T00:00:00Z',
        timeout_at: '2099-01-01T00:00:00Z',
        on_timeout: 'block',
        packet_path: 'approvals/A1-0001/packet.md',
      },
    });

    sm.approveRun(state, 'A1-0001');

    expect(state.checkpoints.last_checkpoint_at).toBeTruthy();
    // Verify persisted
    const readState = sm.readState();
    expect(readState.checkpoints.last_checkpoint_at).toBeTruthy();
  });

  it('resumeRun updates checkpoint timestamp (deferral fix)', () => {
    const sm = new StateManager(tmpDir);
    const state = baseState({ run_id: 'r1', run_status: 'paused' });

    sm.resumeRun(state);

    expect(state.checkpoints.last_checkpoint_at).toBeTruthy();
  });
});

describe('requestApproval (Stage 3a)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates pending approval and transitions to awaiting_approval', () => {
    const sm = new StateManager(tmpDir);
    const state = baseState({
      run_id: 'r1',
      workflow_id: 'w1',
      run_status: 'running',
    });

    const approvalId = sm.requestApproval(state, 'A1', {
      plan_step_ids: ['step_1'],
      packet_path: 'approvals/A1-0001/packet.md',
      note: 'need review',
    });

    expect(approvalId).toBe('A1-0001');
    expect(state.run_status).toBe('awaiting_approval');
    expect(state.pending_approval).not.toBeNull();
    expect(state.pending_approval!.approval_id).toBe('A1-0001');
    expect(state.pending_approval!.category).toBe('A1');
    expect(state.pending_approval!.plan_step_ids).toEqual(['step_1']);
    expect(state.pending_approval!.packet_path).toBe('approvals/A1-0001/packet.md');
    expect(state.pending_approval!.on_timeout).toBe('block'); // default
    expect(state.notes).toBe('need review');
  });

  it('reads timeout from policy via APPROVAL_CATEGORY_TO_POLICY_KEY mapping (Python parity)', () => {
    // Python maps A2 → 'code_changes' for policy lookup
    writePolicy(tmpDir, {
      timeouts: { code_changes: { timeout_seconds: 7200, on_timeout: 'reject' } },
    });

    const sm = new StateManager(tmpDir);
    const state = baseState({
      run_id: 'r1',
      workflow_id: 'w1',
      run_status: 'running',
    });

    sm.requestApproval(state, 'A2', {
      packet_path: 'approvals/A2-0001/packet.md',
    });

    expect(state.pending_approval!.on_timeout).toBe('reject');
    expect(state.pending_approval!.timeout_at).toBeTruthy();
    // timeout_at should be ~7200s after requested_at
    const requested = new Date(state.pending_approval!.requested_at).getTime();
    const timeout = new Date(state.pending_approval!.timeout_at!).getTime();
    const diffSeconds = (timeout - requested) / 1000;
    expect(diffSeconds).toBe(7200);
  });

  it('rejects when already awaiting approval (no force)', () => {
    const sm = new StateManager(tmpDir);
    const state = baseState({
      run_id: 'r1',
      run_status: 'running',
      pending_approval: {
        approval_id: 'A1-0001',
        category: 'A1',
        plan_step_ids: [],
        requested_at: '2026-02-24T00:00:00Z',
        timeout_at: null,
        on_timeout: 'block',
        packet_path: 'approvals/A1-0001/packet.md',
      },
    });

    expect(() =>
      sm.requestApproval(state, 'A1', { packet_path: 'p.md' }),
    ).toThrow(/already awaiting approval/);
  });

  it('rejects when not in running status', () => {
    const sm = new StateManager(tmpDir);
    const state = baseState({ run_id: 'r1', run_status: 'paused' });

    expect(() =>
      sm.requestApproval(state, 'A1', { packet_path: 'p.md' }),
    ).toThrow(/expected 'running'/);
  });

  it('falls back to current_step.step_id when no plan_step_ids provided', () => {
    const sm = new StateManager(tmpDir);
    const state = baseState({
      run_id: 'r1',
      workflow_id: 'w1',
      run_status: 'running',
      current_step: { step_id: 'phase_1', title: 'Phase 1', started_at: '2026-02-24T00:00:00Z' },
    });

    sm.requestApproval(state, 'A1', {
      packet_path: 'approvals/A1-0001/packet.md',
    });

    expect(state.pending_approval!.plan_step_ids).toEqual(['phase_1']);
  });

  it('writes ledger event with category and packet_path in details', () => {
    const sm = new StateManager(tmpDir);
    const state = baseState({
      run_id: 'r1',
      workflow_id: 'w1',
      run_status: 'running',
    });

    sm.requestApproval(state, 'A3', {
      packet_path: 'approvals/A3-0001/packet.md',
    });

    // Read ledger
    const lines = fs.readFileSync(sm.ledgerPath, 'utf-8').trim().split('\n');
    const event = JSON.parse(lines[lines.length - 1]!);
    expect(event.event_type).toBe('approval_requested');
    expect(event.details.approval_id).toBe('A3-0001');
    expect(event.details.category).toBe('A3');
    expect(event.details.packet_path).toBe('approvals/A3-0001/packet.md');
  });
});

describe('Ledger detail parity (Stage 3a)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('approveRun ledger includes category and note (Python parity)', () => {
    const sm = new StateManager(tmpDir);
    const state = baseState({
      run_id: 'r1',
      workflow_id: 'w1',
      run_status: 'awaiting_approval',
      pending_approval: {
        approval_id: 'A1-0001',
        category: 'A1',
        plan_step_ids: ['s1'],
        requested_at: '2026-02-24T00:00:00Z',
        timeout_at: '2099-01-01T00:00:00Z',
        on_timeout: 'block',
        packet_path: 'approvals/A1-0001/packet.md',
      },
    });

    sm.approveRun(state, 'A1-0001', 'looks good');

    const lines = fs.readFileSync(sm.ledgerPath, 'utf-8').trim().split('\n');
    const event = JSON.parse(lines[lines.length - 1]!);
    expect(event.event_type).toBe('approval_approved');
    expect(event.details.approval_id).toBe('A1-0001');
    expect(event.details.category).toBe('A1');
    expect(event.details.note).toBe('looks good');
  });

  it('rejectRun ledger includes category and note (Python parity)', () => {
    const sm = new StateManager(tmpDir);
    const state = baseState({
      run_id: 'r1',
      workflow_id: 'w1',
      run_status: 'awaiting_approval',
      pending_approval: {
        approval_id: 'A2-0001',
        category: 'A2',
        plan_step_ids: [],
        requested_at: '2026-02-24T00:00:00Z',
        timeout_at: '2099-01-01T00:00:00Z',
        on_timeout: 'block',
        packet_path: 'approvals/A2-0001/packet.md',
      },
    });

    sm.rejectRun(state, 'A2-0001', 'not ready');

    const lines = fs.readFileSync(sm.ledgerPath, 'utf-8').trim().split('\n');
    const event = JSON.parse(lines[lines.length - 1]!);
    expect(event.event_type).toBe('approval_rejected');
    expect(event.details.approval_id).toBe('A2-0001');
    expect(event.details.category).toBe('A2');
    expect(event.details.note).toBe('not ready');
  });
});
