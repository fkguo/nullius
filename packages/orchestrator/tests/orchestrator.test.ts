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
      workflow_id: 'computation',
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
    sm.createRun(state, 'test-run-001', 'computation');

    expect(state.run_id).toBe('test-run-001');
    expect(state.workflow_id).toBe('computation');
    expect(state.run_status).toBe('running');

    const readState = sm.readState();
    expect(readState.run_id).toBe('test-run-001');
  });

  it('createRun rejects non-idle state', () => {
    const sm = new StateManager(tmpDir);
    const state = baseState({ run_status: 'running' as RunState['run_status'] });
    expect(() => sm.createRun(state, 'r1', 'ingest')).toThrow("expected 'idle'");
  });

  it('approveRun clears pending and resumes', () => {
    const sm = new StateManager(tmpDir);
    const state = baseState({
      run_id: 'r1',
      workflow_id: 'ingest',
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
      workflow_id: 'ingest',
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

  it('pauseRun from blocked saves paused_from_status and resumes correctly (B1 fix)', () => {
    const sm = new StateManager(tmpDir);
    const state = baseState({ run_id: 'r1', run_status: 'blocked' });
    sm.pauseRun(state);
    expect(state.run_status).toBe('paused');
    expect(state.paused_from_status).toBe('blocked');

    sm.resumeRun(state);
    expect(state.run_status).toBe('blocked');
    expect(state.paused_from_status).toBeUndefined();
  });

  it('pauseRun from awaiting_approval saves paused_from_status (Python parity)', () => {
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
    sm.pauseRun(state);
    expect(state.run_status).toBe('paused');
    expect(state.paused_from_status).toBe('awaiting_approval');
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
    sm.createRun(state, 'lifecycle-001', 'ingest');
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
      workflow_id: 'ingest',
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
      workflow_id: 'ingest',
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
      workflow_id: 'ingest',
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
      workflow_id: 'ingest',
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
      workflow_id: 'ingest',
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
      workflow_id: 'ingest',
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
      workflow_id: 'ingest',
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

// ─── Stage 3b: Sentinel files, paused_from_status, enforcement, checkpoint ───

describe('Sentinel file management (Stage 3b)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('checkStopPause returns null when no sentinel files exist', () => {
    const sm = new StateManager(tmpDir);
    expect(sm.checkStopPause()).toBeNull();
  });

  it('checkStopPause returns "stop" when .stop exists', () => {
    fs.writeFileSync(path.join(tmpDir, '.stop'), 'stop\n');
    const sm = new StateManager(tmpDir);
    expect(sm.checkStopPause()).toBe('stop');
  });

  it('checkStopPause returns "pause" when .pause exists', () => {
    fs.writeFileSync(path.join(tmpDir, '.pause'), 'paused\n');
    const sm = new StateManager(tmpDir);
    expect(sm.checkStopPause()).toBe('pause');
  });

  it('checkStopPause prefers "stop" over "pause" when both exist', () => {
    fs.writeFileSync(path.join(tmpDir, '.stop'), 'stop\n');
    fs.writeFileSync(path.join(tmpDir, '.pause'), 'paused\n');
    const sm = new StateManager(tmpDir);
    expect(sm.checkStopPause()).toBe('stop');
  });

  it('writePauseSentinel creates .pause file at repo root', () => {
    const sm = new StateManager(tmpDir);
    sm.writePauseSentinel();
    const content = fs.readFileSync(path.join(tmpDir, '.pause'), 'utf-8');
    expect(content).toBe('paused\n');
  });

  it('removePauseSentinel removes .pause file', () => {
    fs.writeFileSync(path.join(tmpDir, '.pause'), 'paused\n');
    const sm = new StateManager(tmpDir);
    sm.removePauseSentinel();
    expect(fs.existsSync(path.join(tmpDir, '.pause'))).toBe(false);
  });

  it('removePauseSentinel is best-effort (no error if file missing)', () => {
    const sm = new StateManager(tmpDir);
    expect(() => sm.removePauseSentinel()).not.toThrow();
  });

  it('pauseRun writes .pause sentinel (Python parity)', () => {
    const sm = new StateManager(tmpDir);
    const state = baseState({ run_id: 'r1', run_status: 'running' });
    sm.pauseRun(state);
    expect(fs.existsSync(path.join(tmpDir, '.pause'))).toBe(true);
  });

  it('resumeRun removes .pause sentinel (Python parity)', () => {
    fs.writeFileSync(path.join(tmpDir, '.pause'), 'paused\n');
    const sm = new StateManager(tmpDir);
    const state = baseState({ run_id: 'r1', run_status: 'paused' });
    sm.resumeRun(state);
    expect(fs.existsSync(path.join(tmpDir, '.pause'))).toBe(false);
  });

  it('rejectRun writes .pause sentinel (Python parity)', () => {
    const sm = new StateManager(tmpDir);
    const state = baseState({
      run_id: 'r1',
      workflow_id: 'ingest',
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
    sm.rejectRun(state, 'A1-0001', 'nope');
    expect(fs.existsSync(path.join(tmpDir, '.pause'))).toBe(true);
  });
});

describe('paused_from_status tracking (Stage 3b)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('pauseRun saves paused_from_status when not already paused', () => {
    const sm = new StateManager(tmpDir);
    const state = baseState({ run_id: 'r1', run_status: 'running' });
    sm.pauseRun(state);
    expect(state.paused_from_status).toBe('running');
  });

  it('resumeRun restores paused_from_status and clears it', () => {
    const sm = new StateManager(tmpDir);
    const state = baseState({ run_id: 'r1', run_status: 'paused', paused_from_status: 'running' });
    sm.resumeRun(state);
    expect(state.run_status).toBe('running');
    expect(state.paused_from_status).toBeUndefined();
  });

  it('resumeRun falls back to "running" when no paused_from_status', () => {
    const sm = new StateManager(tmpDir);
    const state = baseState({ run_id: 'r1', run_status: 'paused' });
    sm.resumeRun(state);
    expect(state.run_status).toBe('running');
  });

  it('resumeRun rejects idle/completed/failed without force (Python parity)', () => {
    const sm = new StateManager(tmpDir);
    for (const status of ['idle', 'completed', 'failed'] as const) {
      const state = baseState({ run_id: 'r1', run_status: status });
      expect(() => sm.resumeRun(state)).toThrow(/cannot resume/);
    }
  });

  it('resumeRun allows idle/completed/failed with force (Python parity)', () => {
    const sm = new StateManager(tmpDir);
    const state = baseState({ run_id: 'r1', run_status: 'completed' });
    sm.resumeRun(state, { force: true });
    expect(state.run_status).toBe('running');
  });

  it('paused_from_status persists through save/read cycle', () => {
    const sm = new StateManager(tmpDir);
    const state = baseState({ run_id: 'r1', run_status: 'running' });
    sm.pauseRun(state);
    // Read back from disk
    const read = sm.readState();
    expect(read.paused_from_status).toBe('running');
  });
});

describe('enforceApprovalTimeout (Stage 3b)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns null when no pending approval', () => {
    const sm = new StateManager(tmpDir);
    const state = baseState({ run_id: 'r1', run_status: 'running' });
    expect(sm.enforceApprovalTimeout(state)).toBeNull();
  });

  it('returns null when timeout_at is null', () => {
    const sm = new StateManager(tmpDir);
    const state = baseState({
      run_id: 'r1',
      run_status: 'awaiting_approval',
      pending_approval: {
        approval_id: 'A1-0001',
        category: 'A1',
        plan_step_ids: [],
        requested_at: '2026-02-24T00:00:00Z',
        timeout_at: null,
        on_timeout: 'block',
        packet_path: 'p.md',
      },
    });
    expect(sm.enforceApprovalTimeout(state)).toBeNull();
  });

  it('returns null when timeout_at is malformed (NaN guard, B2 fix)', () => {
    const sm = new StateManager(tmpDir);
    const state = baseState({
      run_id: 'r1',
      run_status: 'awaiting_approval',
      pending_approval: {
        approval_id: 'A1-0001',
        category: 'A1',
        plan_step_ids: [],
        requested_at: '2026-02-24T00:00:00Z',
        timeout_at: 'not-a-date',
        on_timeout: 'block',
        packet_path: 'p.md',
      },
    });
    expect(sm.enforceApprovalTimeout(state)).toBeNull();
  });

  it('returns null when not yet timed out', () => {
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
        packet_path: 'p.md',
      },
    });
    expect(sm.enforceApprovalTimeout(state)).toBeNull();
  });

  it('on_timeout=block: sets blocked + writes ledger', () => {
    const sm = new StateManager(tmpDir);
    const state = baseState({
      run_id: 'r1',
      run_status: 'awaiting_approval',
      pending_approval: {
        approval_id: 'A1-0001',
        category: 'A1',
        plan_step_ids: [],
        requested_at: '2020-01-01T00:00:00Z',
        timeout_at: '2020-01-01T01:00:00Z',
        on_timeout: 'block',
        packet_path: 'p.md',
      },
    });

    const result = sm.enforceApprovalTimeout(state);
    expect(result).toBe('block');
    expect(state.run_status).toBe('blocked');
    expect(state.notes).toContain('blocked');

    // Verify ledger
    const lines = fs.readFileSync(sm.ledgerPath, 'utf-8').trim().split('\n');
    const event = JSON.parse(lines[lines.length - 1]!);
    expect(event.event_type).toBe('approval_timeout');
    expect(event.details.policy_action).toBe('block');
  });

  it('on_timeout=reject: sets rejected + clears pending + adds history', () => {
    const sm = new StateManager(tmpDir);
    const state = baseState({
      run_id: 'r1',
      run_status: 'awaiting_approval',
      pending_approval: {
        approval_id: 'A1-0001',
        category: 'A1',
        plan_step_ids: [],
        requested_at: '2020-01-01T00:00:00Z',
        timeout_at: '2020-01-01T01:00:00Z',
        on_timeout: 'reject',
        packet_path: 'p.md',
      },
    });

    const result = sm.enforceApprovalTimeout(state);
    expect(result).toBe('reject');
    expect(state.run_status).toBe('rejected');
    expect(state.pending_approval).toBeNull();
    expect(state.approval_history).toHaveLength(1);
    expect(state.approval_history[0]!.decision).toBe('timeout_rejected');
    expect(state.approval_history[0]!.note).toContain('auto-rejected');
  });

  it('on_timeout=escalate: sets needs_recovery', () => {
    const sm = new StateManager(tmpDir);
    const state = baseState({
      run_id: 'r1',
      run_status: 'awaiting_approval',
      pending_approval: {
        approval_id: 'A1-0001',
        category: 'A1',
        plan_step_ids: [],
        requested_at: '2020-01-01T00:00:00Z',
        timeout_at: '2020-01-01T01:00:00Z',
        on_timeout: 'escalate',
        packet_path: 'p.md',
      },
    });

    const result = sm.enforceApprovalTimeout(state);
    expect(result).toBe('escalate');
    expect(state.run_status).toBe('needs_recovery');
    expect(state.notes).toContain('escalated');
  });

  it('persists state to disk after timeout enforcement', () => {
    const sm = new StateManager(tmpDir);
    const state = baseState({
      run_id: 'r1',
      run_status: 'awaiting_approval',
      pending_approval: {
        approval_id: 'A1-0001',
        category: 'A1',
        plan_step_ids: [],
        requested_at: '2020-01-01T00:00:00Z',
        timeout_at: '2020-01-01T01:00:00Z',
        on_timeout: 'block',
        packet_path: 'p.md',
      },
    });

    sm.enforceApprovalTimeout(state);

    const read = sm.readState();
    expect(read.run_status).toBe('blocked');
  });
});

describe('enforceApprovalBudget (Stage 3b)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns false when no budget configured', () => {
    const sm = new StateManager(tmpDir);
    const state = baseState({ run_id: 'r1', run_status: 'running' });
    expect(sm.enforceApprovalBudget(state)).toBe(false);
  });

  it('returns false when budget not exhausted', () => {
    writePolicy(tmpDir, { budgets: { max_approvals: 5 } });
    const sm = new StateManager(tmpDir);
    const state = baseState({
      run_id: 'r1',
      run_status: 'running',
      approval_history: [
        { ts: '2020-01-01T00:00:00Z', approval_id: 'a1', category: 'A1', decision: 'approved', note: '' },
      ],
    });
    expect(sm.enforceApprovalBudget(state)).toBe(false);
  });

  it('returns true + sets blocked when budget exhausted', () => {
    writePolicy(tmpDir, { budgets: { max_approvals: 1 } });
    const sm = new StateManager(tmpDir);
    const state = baseState({
      run_id: 'r1',
      run_status: 'running',
      approval_history: [
        { ts: '2020-01-01T00:00:00Z', approval_id: 'a1', category: 'A1', decision: 'approved', note: '' },
      ],
    });

    expect(sm.enforceApprovalBudget(state)).toBe(true);
    expect(state.run_status).toBe('blocked');
    expect(state.notes).toContain('budget exhausted');
  });

  it('clears pending_approval when budget exhausted', () => {
    writePolicy(tmpDir, { budgets: { max_approvals: 1 } });
    const sm = new StateManager(tmpDir);
    const state = baseState({
      run_id: 'r1',
      run_status: 'awaiting_approval',
      pending_approval: {
        approval_id: 'A1-0002',
        category: 'A1',
        plan_step_ids: [],
        requested_at: '2020-01-01T00:00:00Z',
        timeout_at: null,
        on_timeout: 'block',
        packet_path: 'p.md',
      },
      approval_history: [
        { ts: '2020-01-01T00:00:00Z', approval_id: 'a1', category: 'A1', decision: 'approved', note: '' },
      ],
    });

    sm.enforceApprovalBudget(state);
    expect(state.pending_approval).toBeNull();
  });

  it('writes ledger event with granted/max_approvals details', () => {
    writePolicy(tmpDir, { budgets: { max_approvals: 2 } });
    const sm = new StateManager(tmpDir);
    const state = baseState({
      run_id: 'r1',
      run_status: 'running',
      approval_history: [
        { ts: '2020-01-01T00:00:00Z', approval_id: 'a1', category: 'A1', decision: 'approved', note: '' },
        { ts: '2020-01-01T01:00:00Z', approval_id: 'a2', category: 'A2', decision: 'approved', note: '' },
      ],
    });

    sm.enforceApprovalBudget(state);

    const lines = fs.readFileSync(sm.ledgerPath, 'utf-8').trim().split('\n');
    const event = JSON.parse(lines[lines.length - 1]!);
    expect(event.event_type).toBe('approval_budget_exhausted');
    expect(event.details.granted).toBe(2);
    expect(event.details.max_approvals).toBe(2);
  });

  it('only counts "approved" decisions (not rejected)', () => {
    writePolicy(tmpDir, { budgets: { max_approvals: 2 } });
    const sm = new StateManager(tmpDir);
    const state = baseState({
      run_id: 'r1',
      run_status: 'running',
      approval_history: [
        { ts: '2020-01-01T00:00:00Z', approval_id: 'a1', category: 'A1', decision: 'approved', note: '' },
        { ts: '2020-01-01T01:00:00Z', approval_id: 'a2', category: 'A2', decision: 'rejected', note: '' },
      ],
    });
    expect(sm.enforceApprovalBudget(state)).toBe(false);
  });
});

describe('checkpoint command (Stage 3b)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('updates checkpoint timestamp and persists', () => {
    const sm = new StateManager(tmpDir);
    const state = baseState({ run_id: 'r1', run_status: 'running' });
    sm.saveState(state);

    const result = sm.checkpoint(state);
    expect(result.action).toBeUndefined();
    expect(state.checkpoints.last_checkpoint_at).toBeTruthy();

    const read = sm.readState();
    expect(read.checkpoints.last_checkpoint_at).toBeTruthy();
  });

  it('rejects checkpoint in terminal status without force', () => {
    const sm = new StateManager(tmpDir);
    const state = baseState({ run_id: 'r1', run_status: 'completed' });
    expect(() => sm.checkpoint(state)).toThrow(/--force/);
  });

  it('allows checkpoint in terminal status with force', () => {
    const sm = new StateManager(tmpDir);
    const state = baseState({ run_id: 'r1', run_status: 'completed' });
    // force bypasses status guard; no budget/timeout configured → just checkpoints
    sm.checkpoint(state, { force: true });
    expect(state.checkpoints.last_checkpoint_at).toBeTruthy();
  });

  it('short-circuits on approval timeout', () => {
    const sm = new StateManager(tmpDir);
    const state = baseState({
      run_id: 'r1',
      run_status: 'awaiting_approval',
      pending_approval: {
        approval_id: 'A1-0001',
        category: 'A1',
        plan_step_ids: [],
        requested_at: '2020-01-01T00:00:00Z',
        timeout_at: '2020-01-01T01:00:00Z',
        on_timeout: 'reject',
        packet_path: 'p.md',
      },
    });

    const result = sm.checkpoint(state);
    expect(result.action).toBe('approval_timeout:reject');
    expect(state.run_status).toBe('rejected');
  });

  it('short-circuits on budget exhausted', () => {
    writePolicy(tmpDir, { budgets: { max_approvals: 1 } });
    const sm = new StateManager(tmpDir);
    const state = baseState({
      run_id: 'r1',
      run_status: 'running',
      approval_history: [
        { ts: '2020-01-01T00:00:00Z', approval_id: 'a1', category: 'A1', decision: 'approved', note: '' },
      ],
    });

    const result = sm.checkpoint(state);
    expect(result.action).toBe('budget_exhausted');
    expect(state.run_status).toBe('blocked');
  });

  it('updates current_step when step_id provided', () => {
    const sm = new StateManager(tmpDir);
    const state = baseState({ run_id: 'r1', run_status: 'running' });

    sm.checkpoint(state, { step_id: 'phase_2', step_title: 'Phase 2' });

    expect(state.current_step?.step_id).toBe('phase_2');
    expect(state.current_step?.title).toBe('Phase 2');
    expect(state.current_step?.started_at).toBeTruthy();
  });

  it('writes ledger event with note', () => {
    const sm = new StateManager(tmpDir);
    const state = baseState({ run_id: 'r1', run_status: 'running' });

    sm.checkpoint(state, { note: 'progress update' });

    const lines = fs.readFileSync(sm.ledgerPath, 'utf-8').trim().split('\n');
    const event = JSON.parse(lines[lines.length - 1]!);
    expect(event.event_type).toBe('checkpoint');
    expect(event.details.note).toBe('progress update');
  });

  it('checkpoint allowed in paused and awaiting_approval status', () => {
    const sm = new StateManager(tmpDir);

    // Paused
    const state1 = baseState({ run_id: 'r1', run_status: 'paused' });
    expect(() => sm.checkpoint(state1)).not.toThrow();

    // awaiting_approval (with no timeout)
    const state2 = baseState({
      run_id: 'r2',
      run_status: 'awaiting_approval',
      pending_approval: {
        approval_id: 'A1-0001',
        category: 'A1',
        plan_step_ids: [],
        requested_at: '2026-02-24T00:00:00Z',
        timeout_at: null,
        on_timeout: 'block',
        packet_path: 'p.md',
      },
    });
    expect(() => sm.checkpoint(state2)).not.toThrow();
  });
});

describe('Ledger detail parity (Stage 3b regression)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('explicit eventType ledger events omit injected from/to (Python SSOT parity)', () => {
    const sm = new StateManager(tmpDir);
    const state = baseState({ run_id: 'r1' });

    // createRun → run_started
    sm.createRun(state, 'r1', 'ingest');
    const lines = fs.readFileSync(sm.ledgerPath, 'utf-8').trim().split('\n');
    const runStarted = JSON.parse(lines[lines.length - 1]!);
    expect(runStarted.event_type).toBe('run_started');
    expect(runStarted.details.from).toBeUndefined();
    expect(runStarted.details.to).toBeUndefined();
    expect(runStarted.details.note).toBe('');

    // pauseRun → paused
    sm.pauseRun(state, 'halt');
    const lines2 = fs.readFileSync(sm.ledgerPath, 'utf-8').trim().split('\n');
    const paused = JSON.parse(lines2[lines2.length - 1]!);
    expect(paused.event_type).toBe('paused');
    expect(paused.details.from).toBeUndefined();
    expect(paused.details.to).toBeUndefined();
    expect(paused.details.note).toBe('halt');

    // resumeRun → resumed
    sm.resumeRun(state, { note: 'go' });
    const lines3 = fs.readFileSync(sm.ledgerPath, 'utf-8').trim().split('\n');
    const resumed = JSON.parse(lines3[lines3.length - 1]!);
    expect(resumed.event_type).toBe('resumed');
    expect(resumed.details.from).toBeUndefined();
    expect(resumed.details.to).toBeUndefined();
    expect(resumed.details.note).toBe('go');
  });

  it('removePauseSentinel runs before idle guard (B3 regression)', () => {
    const sm = new StateManager(tmpDir);
    // Create .pause sentinel manually
    fs.writeFileSync(path.join(tmpDir, '.pause'), 'paused\n', 'utf-8');
    const state = baseState({ run_id: 'r1', run_status: 'completed' });
    // Resume should throw (completed without force), but .pause should still be removed
    expect(() => sm.resumeRun(state)).toThrow(/cannot resume/);
    expect(fs.existsSync(path.join(tmpDir, '.pause'))).toBe(false);
  });
});

// ─── Stage 3c: Plan validation + plan.md derivation ───

/** Minimal valid plan for tests. */
function basePlan(overrides?: Record<string, unknown>): Record<string, unknown> {
  return {
    schema_version: 1,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    run_id: 'test-run',
    workflow_id: 'test-workflow',
    steps: [
      {
        step_id: 'step_1',
        description: 'First step',
        status: 'pending',
        expected_approvals: ['A1'],
        expected_outputs: ['output1.json'],
        recovery_notes: 'retry',
      },
    ],
    ...overrides,
  };
}

/** Plan with branching for testing. */
function planWithBranching(overrides?: Record<string, unknown>): Record<string, unknown> {
  return basePlan({
    steps: [
      {
        step_id: 'step_1',
        description: 'First step',
        status: 'pending',
        expected_approvals: [],
        expected_outputs: [],
        recovery_notes: '',
      },
      {
        step_id: 'step_2',
        description: 'Second step',
        status: 'pending',
        expected_approvals: [],
        expected_outputs: [],
        recovery_notes: '',
      },
    ],
    branching: {
      schema_version: 1,
      active_branch_id: 'dec1:branch_a',
      max_branches_per_decision: 5,
      decisions: [
        {
          decision_id: 'dec1',
          title: 'Pick approach',
          step_id: 'step_1',
          created_at: '2026-01-01T00:00:00Z',
          updated_at: '2026-01-01T00:00:00Z',
          max_branches: 3,
          active_branch_id: 'branch_a',
          branches: [
            {
              branch_id: 'branch_a',
              label: 'Approach A',
              description: 'Do A',
              status: 'active',
              expected_approvals: [],
              expected_outputs: [],
              recovery_notes: '',
            },
            {
              branch_id: 'branch_b',
              label: 'Approach B',
              description: 'Do B',
              status: 'candidate',
              expected_approvals: [],
              expected_outputs: [],
              recovery_notes: '',
            },
          ],
          notes: '',
        },
      ],
      notes: '',
    },
    ...overrides,
  });
}

describe('Stage 3c: validatePlan', () => {
  let tmpDir: string;
  let sm: StateManager;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    sm = new StateManager(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('accepts a valid plan without branching', () => {
    expect(() => sm.validatePlan(basePlan())).not.toThrow();
  });

  it('accepts a valid plan with branching', () => {
    expect(() => sm.validatePlan(planWithBranching())).not.toThrow();
  });

  it('rejects plan with invalid schema_version', () => {
    expect(() => sm.validatePlan(basePlan({ schema_version: 0 }))).toThrow(/schema_version/);
    expect(() => sm.validatePlan(basePlan({ schema_version: 'x' }))).toThrow(/schema_version/);
  });

  it('rejects plan with missing created_at', () => {
    // Empty string is valid per schema (type: string, no minLength) — matches Python behavior
    // But non-string is rejected
    expect(() => sm.validatePlan(basePlan({ created_at: 123 }))).toThrow(/created_at/);
  });

  it('rejects plan with missing updated_at', () => {
    // Non-string is rejected
    expect(() => sm.validatePlan(basePlan({ updated_at: 123 }))).toThrow(/updated_at/);
  });

  it('rejects plan with non-array steps', () => {
    expect(() => sm.validatePlan(basePlan({ steps: 'oops' }))).toThrow(/schema validation failed/);
  });

  it('rejects step with missing step_id', () => {
    const plan = basePlan({
      steps: [{ step_id: '', description: 'x', status: 'pending', expected_approvals: [], expected_outputs: [], recovery_notes: '' }],
    });
    expect(() => sm.validatePlan(plan)).toThrow(/step_id/);
  });

  it('rejects step with invalid status', () => {
    const plan = basePlan({
      steps: [{ step_id: 's1', description: 'x', status: 'INVALID', expected_approvals: [], expected_outputs: [], recovery_notes: '' }],
    });
    expect(() => sm.validatePlan(plan)).toThrow(/status/);
  });

  it('rejects step with non-array expected_approvals', () => {
    const plan = basePlan({
      steps: [{ step_id: 's1', description: 'x', status: 'pending', expected_approvals: 'A1', expected_outputs: [], recovery_notes: '' }],
    });
    expect(() => sm.validatePlan(plan)).toThrow(/expected_approvals/);
  });

  // ─── New schema coverage tests (additionalProperties, enum, nested required) ───

  it('rejects plan with unexpected top-level properties', () => {
    const plan = basePlan({ extraField: 'bad' });
    expect(() => sm.validatePlan(plan)).toThrow(/unexpected properties.*extraField/);
  });

  it('rejects step with invalid approval category (enum)', () => {
    const plan = basePlan({
      steps: [{ step_id: 's1', description: 'x', status: 'pending', expected_approvals: ['A6'], expected_outputs: [], recovery_notes: '' }],
    });
    expect(() => sm.validatePlan(plan)).toThrow(/not in enum/);
  });

  it('rejects step with unexpected properties (additionalProperties)', () => {
    const plan = basePlan({
      steps: [{ step_id: 's1', description: 'x', status: 'pending', expected_approvals: [], expected_outputs: [], recovery_notes: '', bonus: true }],
    });
    expect(() => sm.validatePlan(plan)).toThrow(/unexpected properties.*bonus/);
  });

  it('rejects branching with missing required fields', () => {
    const plan = basePlan({
      branching: { schema_version: 1 },
    });
    expect(() => sm.validatePlan(plan)).toThrow(/schema validation failed/);
  });

  it('rejects branch with invalid status enum', () => {
    const plan = planWithBranching();
    const br = plan.branching as Record<string, unknown>;
    const decisions = br.decisions as Record<string, unknown>[];
    const branches = decisions[0].branches as Record<string, unknown>[];
    branches[0].status = 'invalid_status';
    br.active_branch_id = null;
    decisions[0].active_branch_id = null;
    expect(() => sm.validatePlan(plan)).toThrow(/not in enum/);
  });

  // ─── Branching invariants ───

  it('rejects duplicate decision_id', () => {
    const plan = planWithBranching();
    const branching = plan.branching as Record<string, unknown>;
    const dec = (branching.decisions as Record<string, unknown>[])[0];
    branching.decisions = [dec, { ...dec }];
    branching.active_branch_id = null;
    expect(() => sm.validatePlan(plan)).toThrow(/duplicate branch_decision decision_id/);
  });

  it('rejects decision.step_id not in plan.steps', () => {
    const plan = planWithBranching();
    const branching = plan.branching as Record<string, unknown>;
    const decs = branching.decisions as Record<string, unknown>[];
    decs[0].step_id = 'nonexistent_step';
    expect(() => sm.validatePlan(plan)).toThrow(/not found in plan\.steps/);
  });

  it('rejects duplicate branch_id within decision', () => {
    const plan = planWithBranching();
    const branching = plan.branching as Record<string, unknown>;
    const dec = (branching.decisions as Record<string, unknown>[])[0];
    const br = (dec.branches as Record<string, unknown>[])[0];
    dec.branches = [br, { ...br, status: 'candidate' }];
    expect(() => sm.validatePlan(plan)).toThrow(/duplicate branch_id/);
  });

  it('rejects active_branch_id pointing to non-existent branch', () => {
    const plan = planWithBranching();
    const branching = plan.branching as Record<string, unknown>;
    const dec = (branching.decisions as Record<string, unknown>[])[0];
    dec.active_branch_id = 'ghost';
    branching.active_branch_id = null;
    expect(() => sm.validatePlan(plan)).toThrow(/not found in branches/);
  });

  it('rejects active_branch_id pointing to non-active branch', () => {
    const plan = planWithBranching();
    const branching = plan.branching as Record<string, unknown>;
    const dec = (branching.decisions as Record<string, unknown>[])[0];
    dec.active_branch_id = 'branch_b';
    (dec.branches as Record<string, unknown>[])[0].status = 'candidate';
    branching.active_branch_id = null;
    expect(() => sm.validatePlan(plan)).toThrow(/must have status 'active'/);
  });

  it('rejects multiple active branches in one decision', () => {
    const plan = planWithBranching();
    const branching = plan.branching as Record<string, unknown>;
    const dec = (branching.decisions as Record<string, unknown>[])[0];
    (dec.branches as Record<string, unknown>[])[1].status = 'active';
    expect(() => sm.validatePlan(plan)).toThrow(/multiple active branches/);
  });

  it('rejects inconsistency between active branch and decision.active_branch_id', () => {
    const plan = planWithBranching();
    const branching = plan.branching as Record<string, unknown>;
    const dec = (branching.decisions as Record<string, unknown>[])[0];
    dec.active_branch_id = null;
    branching.active_branch_id = null;
    expect(() => sm.validatePlan(plan)).toThrow(/marked active but decision\.active_branch_id/);
  });

  it('rejects global active_branch_id with wrong format', () => {
    const plan = planWithBranching();
    const branching = plan.branching as Record<string, unknown>;
    branching.active_branch_id = 'no-colon-here';
    expect(() => sm.validatePlan(plan)).toThrow(/composite/);
  });

  it('rejects global active_branch_id when no active pairs', () => {
    const plan = basePlan({
      branching: {
        schema_version: 1,
        active_branch_id: 'dec1:branch_a',
        max_branches_per_decision: 5,
        decisions: [],
        notes: '',
      },
    });
    expect(() => sm.validatePlan(plan)).toThrow(/no branch candidate has status 'active'/);
  });

  it('rejects global active_branch_id pointing to wrong pair', () => {
    const plan = planWithBranching();
    const branching = plan.branching as Record<string, unknown>;
    branching.active_branch_id = 'dec1:branch_b';
    expect(() => sm.validatePlan(plan)).toThrow(/not active in its decision/);
  });

  it('accepts plan with branching=null', () => {
    const plan = basePlan({ branching: null });
    expect(() => sm.validatePlan(plan)).not.toThrow();
  });
});

describe('Stage 3c: renderPlanMd', () => {
  let tmpDir: string;
  let sm: StateManager;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    sm = new StateManager(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('renders plan without branching', () => {
    const md = sm.renderPlanMd(basePlan());
    expect(md).toContain('# Plan (derived view)');
    expect(md).toContain('- Run: test-run');
    expect(md).toContain('- Workflow: test-workflow');
    expect(md).toContain('SSOT: `.autoresearch/state.json#/plan`');
    expect(md).toContain('## Steps');
    expect(md).toContain('1. [pending] step_1 — First step');
    expect(md).toContain('   - expected_approvals: A1');
    expect(md).toContain('     - output1.json');
    expect(md).toContain('   - recovery_notes: retry');
    expect(md).not.toContain('## Branching');
  });

  it('renders plan with branching', () => {
    const md = sm.renderPlanMd(planWithBranching());
    expect(md).toContain('## Branching');
    expect(md).toContain('- active_branch_id: dec1:branch_a');
    expect(md).toContain('- max_branches_per_decision: 5');
    expect(md).toContain('### Decisions');
    expect(md).toContain('1. dec1 — Pick approach');
    expect(md).toContain('   - active_branch_id: branch_a');
    expect(md).toContain('     - [active] branch_a — Approach A: Do A');
    expect(md).toContain('     - [candidate] branch_b — Approach B: Do B');
  });

  it('uses (unknown) for missing run_id and workflow_id', () => {
    const plan = basePlan({ run_id: undefined, workflow_id: undefined });
    delete plan.run_id;
    delete plan.workflow_id;
    const md = sm.renderPlanMd(plan);
    expect(md).toContain('- Run: (unknown)');
    expect(md).toContain('- Workflow: (unknown)');
  });

  it('uses (unknown) for empty-string run_id and workflow_id (Python or semantics)', () => {
    const plan = basePlan({ run_id: '', workflow_id: '' });
    const md = sm.renderPlanMd(plan);
    expect(md).toContain('- Run: (unknown)');
    expect(md).toContain('- Workflow: (unknown)');
  });

  it('omits Updated line when updated_at is missing', () => {
    const plan = basePlan();
    delete plan.updated_at;
    const md = sm.renderPlanMd(plan);
    expect(md).not.toContain('- Updated:');
  });
});

describe('Stage 3c: writePlanMd', () => {
  let tmpDir: string;
  let sm: StateManager;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    sm = new StateManager(tmpDir);
    sm.ensureDirs();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('writes plan.md atomically and returns relative path', () => {
    const relPath = sm.writePlanMd(basePlan());
    expect(relPath).toBe(path.join('.autoresearch', 'plan.md'));
    const content = fs.readFileSync(path.join(tmpDir, '.autoresearch', 'plan.md'), 'utf-8');
    expect(content).toContain('# Plan (derived view)');
    expect(fs.existsSync(path.join(tmpDir, '.autoresearch', 'plan.md.tmp'))).toBe(false);
  });

  it('throws on invalid plan (validation runs before write)', () => {
    expect(() => sm.writePlanMd({ schema_version: 0, steps: [] } as Record<string, unknown>)).toThrow(/schema_version/);
    expect(fs.existsSync(path.join(tmpDir, '.autoresearch', 'plan.md'))).toBe(false);
  });
});

describe('Stage 3c: saveState with plan', () => {
  let tmpDir: string;
  let sm: StateManager;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    sm = new StateManager(tmpDir);
    sm.ensureDirs();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('validates plan, sets plan_md_path, and derives plan.md on saveState', () => {
    const state = baseState({ plan: basePlan() });
    sm.saveState(state);
    expect(state.plan_md_path).toBe(path.join('.autoresearch', 'plan.md'));
    const stateJson = JSON.parse(fs.readFileSync(path.join(tmpDir, '.autoresearch', 'state.json'), 'utf-8'));
    expect(stateJson.plan_md_path).toBe(path.join('.autoresearch', 'plan.md'));
    const md = fs.readFileSync(path.join(tmpDir, '.autoresearch', 'plan.md'), 'utf-8');
    expect(md).toContain('# Plan (derived view)');
  });

  it('skips plan validation when plan is null', () => {
    const state = baseState({ plan: null });
    expect(() => sm.saveState(state)).not.toThrow();
    expect(fs.existsSync(path.join(tmpDir, '.autoresearch', 'plan.md'))).toBe(false);
  });

  it('throws on invalid plan in saveState', () => {
    const state = baseState({ plan: { schema_version: -1, steps: [] } });
    expect(() => sm.saveState(state)).toThrow(/schema_version/);
  });

  it('derives correct plan_md_path when HEP_AUTORESEARCH_DIR is overridden', () => {
    const customDir = path.join(tmpDir, 'custom_state_dir');
    const origEnv = process.env['HEP_AUTORESEARCH_DIR'];
    try {
      process.env['HEP_AUTORESEARCH_DIR'] = customDir;
      const customSm = new StateManager(tmpDir);
      customSm.ensureDirs();
      const state = baseState({ plan: basePlan() });
      customSm.saveState(state);
      // plan_md_path should be relative to repoRoot (custom_state_dir/plan.md)
      expect(state.plan_md_path).toBe(path.relative(tmpDir, path.join(customDir, 'plan.md')));
      expect(fs.existsSync(path.join(customDir, 'plan.md'))).toBe(true);
    } finally {
      if (origEnv === undefined) delete process.env['HEP_AUTORESEARCH_DIR'];
      else process.env['HEP_AUTORESEARCH_DIR'] = origEnv;
      fs.rmSync(customDir, { recursive: true, force: true });
    }
  });

  it('skips plan validation when plan is an array (matching Python isinstance(plan, dict) guard)', () => {
    // In JS, typeof [] === 'object', so we need the Array.isArray guard
    const state = baseState({ plan: [] as unknown as Record<string, unknown> });
    expect(() => sm.saveState(state)).not.toThrow();
    expect(fs.existsSync(path.join(tmpDir, '.autoresearch', 'plan.md'))).toBe(false);
  });
});

describe('Stage 3c: saveStateWithLedger with plan', () => {
  let tmpDir: string;
  let sm: StateManager;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    sm = new StateManager(tmpDir);
    sm.ensureDirs();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('validates plan and derives plan.md during saveStateWithLedger', () => {
    const state = baseState({ plan: basePlan(), run_status: 'running', run_id: 'r1' });
    sm.saveStateWithLedger(state, 'checkpoint', { details: {} });
    expect(state.plan_md_path).toBe(path.join('.autoresearch', 'plan.md'));
    expect(fs.existsSync(path.join(tmpDir, '.autoresearch', 'plan.md'))).toBe(true);
  });

  it('throws on invalid plan in saveStateWithLedger', () => {
    const state = baseState({ plan: { schema_version: 0, steps: [] } });
    expect(() => sm.saveStateWithLedger(state, 'checkpoint')).toThrow(/schema_version/);
  });
});

describe('Stage 3c: syncPlanCurrentStep', () => {
  let tmpDir: string;
  let sm: StateManager;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    sm = new StateManager(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('sets matching step to in_progress and auto-completes other in_progress steps', () => {
    const plan = basePlan({
      steps: [
        { step_id: 's1', description: 'Step 1', status: 'in_progress', expected_approvals: [], expected_outputs: [], recovery_notes: '', started_at: '2026-01-01T00:00:00Z', completed_at: null },
        { step_id: 's2', description: 'Step 2', status: 'pending', expected_approvals: [], expected_outputs: [], recovery_notes: '', started_at: null, completed_at: null },
      ],
    });
    const state = baseState({ plan });
    sm.syncPlanCurrentStep(state, 's2', 'Step 2 title');
    const steps = (state.plan as Record<string, unknown>).steps as Record<string, unknown>[];
    expect(steps[0].status).toBe('completed');
    expect(steps[0].completed_at).toBeTruthy();
    expect(steps[1].status).toBe('in_progress');
    expect(steps[1].started_at).toBeTruthy();
    expect(steps[1].completed_at).toBeNull();
    expect((state.plan as Record<string, unknown>).current_step_id).toBe('s2');
  });

  it('appends new step if step_id not found', () => {
    const plan = basePlan({ steps: [] });
    const state = baseState({ plan });
    sm.syncPlanCurrentStep(state, 'new_step', 'New Step');
    const steps = (state.plan as Record<string, unknown>).steps as Record<string, unknown>[];
    expect(steps).toHaveLength(1);
    expect(steps[0].step_id).toBe('new_step');
    expect(steps[0].status).toBe('in_progress');
    expect(steps[0].description).toBe('New Step');
  });

  it('does nothing when plan is null', () => {
    const state = baseState({ plan: null });
    sm.syncPlanCurrentStep(state, 's1', 'title');
    expect(state.plan).toBeNull();
  });

  it('sets description from title when step description is empty', () => {
    const plan = basePlan({
      steps: [
        { step_id: 's1', description: '', status: 'pending', expected_approvals: [], expected_outputs: [], recovery_notes: '' },
      ],
    });
    const state = baseState({ plan });
    sm.syncPlanCurrentStep(state, 's1', 'Title from caller');
    const steps = (state.plan as Record<string, unknown>).steps as Record<string, unknown>[];
    expect(steps[0].description).toBe('Title from caller');
  });

  it('does not overwrite existing started_at', () => {
    const plan = basePlan({
      steps: [
        { step_id: 's1', description: 'x', status: 'completed', expected_approvals: [], expected_outputs: [], recovery_notes: '', started_at: '2025-01-01T00:00:00Z', completed_at: '2025-06-01T00:00:00Z' },
      ],
    });
    const state = baseState({ plan });
    sm.syncPlanCurrentStep(state, 's1', '');
    const steps = (state.plan as Record<string, unknown>).steps as Record<string, unknown>[];
    expect(steps[0].started_at).toBe('2025-01-01T00:00:00Z');
    expect(steps[0].status).toBe('in_progress');
  });

  it('initializes steps array when plan.steps is missing', () => {
    const plan = basePlan();
    delete (plan as Record<string, unknown>).steps;
    const state = baseState({ plan });
    sm.syncPlanCurrentStep(state, 's1', 'New');
    const steps = (state.plan as Record<string, unknown>).steps as unknown[];
    expect(steps).toHaveLength(1);
  });
});

describe('Stage 3c: syncPlanTerminal', () => {
  let tmpDir: string;
  let sm: StateManager;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    sm = new StateManager(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('sets step to completed with completed_at', () => {
    const plan = basePlan({
      steps: [
        { step_id: 's1', description: 'Step 1', status: 'in_progress', expected_approvals: [], expected_outputs: [], recovery_notes: '', started_at: '2026-01-01T00:00:00Z', completed_at: null },
      ],
    });
    const state = baseState({ plan });
    sm.syncPlanTerminal(state, 's1', '', 'completed');
    const steps = (state.plan as Record<string, unknown>).steps as Record<string, unknown>[];
    expect(steps[0].status).toBe('completed');
    expect(steps[0].completed_at).toBeTruthy();
  });

  it('sets step to failed with completed_at', () => {
    const plan = basePlan({
      steps: [
        { step_id: 's1', description: 'Step 1', status: 'in_progress', expected_approvals: [], expected_outputs: [], recovery_notes: '' },
      ],
    });
    const state = baseState({ plan });
    sm.syncPlanTerminal(state, 's1', '', 'failed');
    const steps = (state.plan as Record<string, unknown>).steps as Record<string, unknown>[];
    expect(steps[0].status).toBe('failed');
    expect(steps[0].completed_at).toBeTruthy();
  });

  it('sets step to skipped without completed_at', () => {
    const plan = basePlan({
      steps: [
        { step_id: 's1', description: 'Step 1', status: 'pending', expected_approvals: [], expected_outputs: [], recovery_notes: '' },
      ],
    });
    const state = baseState({ plan });
    sm.syncPlanTerminal(state, 's1', '', 'skipped');
    const steps = (state.plan as Record<string, unknown>).steps as Record<string, unknown>[];
    expect(steps[0].status).toBe('skipped');
    expect(steps[0].completed_at).toBeFalsy();
  });

  it('appends new step if not found', () => {
    const plan = basePlan({ steps: [] });
    const state = baseState({ plan });
    sm.syncPlanTerminal(state, 'new_s', 'New Step', 'completed');
    const steps = (state.plan as Record<string, unknown>).steps as Record<string, unknown>[];
    expect(steps).toHaveLength(1);
    expect(steps[0].step_id).toBe('new_s');
    expect(steps[0].status).toBe('completed');
    expect(steps[0].completed_at).toBeTruthy();
    expect(steps[0].started_at).toBeNull();
  });

  it('does nothing when plan is null', () => {
    const state = baseState({ plan: null });
    sm.syncPlanTerminal(state, 's1', 'title', 'completed');
    expect(state.plan).toBeNull();
  });

  it('does not overwrite existing completed_at', () => {
    const plan = basePlan({
      steps: [
        { step_id: 's1', description: 'x', status: 'in_progress', expected_approvals: [], expected_outputs: [], recovery_notes: '', completed_at: '2025-06-01T00:00:00Z' },
      ],
    });
    const state = baseState({ plan });
    sm.syncPlanTerminal(state, 's1', '', 'completed');
    const steps = (state.plan as Record<string, unknown>).steps as Record<string, unknown>[];
    expect(steps[0].completed_at).toBe('2025-06-01T00:00:00Z');
  });
});

describe('Stage 3c: checkpoint with plan step sync', () => {
  let tmpDir: string;
  let sm: StateManager;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    sm = new StateManager(tmpDir);
    sm.ensureDirs();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('syncs plan step when step_id is provided in checkpoint', () => {
    const plan = basePlan({
      steps: [
        { step_id: 's1', description: 'Step 1', status: 'pending', expected_approvals: [], expected_outputs: [], recovery_notes: '' },
      ],
    });
    const state = baseState({ plan, run_status: 'running', run_id: 'r1' });
    writeState(tmpDir, state);
    sm.checkpoint(state, { step_id: 's1', step_title: 'Step 1' });
    const steps = (state.plan as Record<string, unknown>).steps as Record<string, unknown>[];
    expect(steps[0].status).toBe('in_progress');
    expect((state.plan as Record<string, unknown>).current_step_id).toBe('s1');
  });

  it('does not sync plan when step_id is not provided', () => {
    const plan = basePlan({
      steps: [
        { step_id: 's1', description: 'Step 1', status: 'pending', expected_approvals: [], expected_outputs: [], recovery_notes: '' },
      ],
    });
    const state = baseState({ plan, run_status: 'running', run_id: 'r1' });
    writeState(tmpDir, state);
    sm.checkpoint(state, { note: 'heartbeat only' });
    const steps = (state.plan as Record<string, unknown>).steps as Record<string, unknown>[];
    expect(steps[0].status).toBe('pending');
  });
});
