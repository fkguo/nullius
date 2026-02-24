// @autoresearch/orchestrator — StateManager (NEW-05a Stage 2)
// Read + write state operations. Compatible with Python orchestrator_state.py.
// Atomic writes: .tmp → rename (H-07 pre-requisite).

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { RunState, RunStatus, ApprovalPolicy, ApprovalHistoryEntry, LedgerEvent } from './types.js';
import { sortKeysRecursive, utcNowIso } from './util.js';

const AUTORESEARCH_DIRNAME = '.autoresearch';
const STATE_FILENAME = 'state.json';
const LEDGER_FILENAME = 'ledger.jsonl';
const APPROVAL_POLICY_FILENAME = 'approval_policy.json';

/** Maps approval category (A1–A5) to policy timeout key.
 *  Must match Python APPROVAL_CATEGORY_TO_POLICY_KEY in orchestrator_state.py. */
const APPROVAL_CATEGORY_TO_POLICY_KEY: Record<string, string> = {
  A1: 'mass_search',
  A2: 'code_changes',
  A3: 'compute_runs',
  A4: 'paper_edits',
  A5: 'final_conclusions',
};

function autoresearchDir(repoRoot: string): string {
  const override = process.env['HEP_AUTORESEARCH_DIR'];
  if (override) {
    return path.isAbsolute(override) ? override : path.join(repoRoot, override);
  }
  return path.join(repoRoot, AUTORESEARCH_DIRNAME);
}

function defaultState(): RunState {
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
  };
}

/** Atomic JSON write: write to .tmp, then rename.
 *  Matches Python _write_json_atomic: indent=2, sort_keys=True, trailing newline. */
function writeJsonAtomic(filePath: string, payload: Record<string, unknown>): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const tmp = filePath + '.tmp';
  const content = JSON.stringify(sortKeysRecursive(payload), null, 2) + '\n';
  fs.writeFileSync(tmp, content, 'utf-8');
  fs.renameSync(tmp, filePath);
}

/** Append a ledger event line. */
function appendLedgerLine(
  ledgerFilePath: string,
  event: LedgerEvent,
): void {
  const dir = path.dirname(ledgerFilePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const line = JSON.stringify(sortKeysRecursive(event)) + '\n';
  fs.appendFileSync(ledgerFilePath, line, 'utf-8');
}

/** Valid status transitions. */
const VALID_TRANSITIONS: Record<string, RunStatus[]> = {
  idle: ['running'],
  running: ['paused', 'awaiting_approval', 'completed', 'failed', 'needs_recovery', 'blocked'],
  paused: ['running'],
  awaiting_approval: ['running', 'paused', 'rejected', 'blocked', 'needs_recovery'],
  blocked: ['running', 'failed'],
  needs_recovery: ['running', 'paused', 'failed'],
  completed: [],
  failed: [],
  rejected: [],
};

export class StateManager {
  private readonly dir: string;

  constructor(repoRoot: string) {
    this.dir = autoresearchDir(repoRoot);
  }

  get statePath(): string {
    return path.join(this.dir, STATE_FILENAME);
  }

  get ledgerPath(): string {
    return path.join(this.dir, LEDGER_FILENAME);
  }

  get policyPath(): string {
    return path.join(this.dir, APPROVAL_POLICY_FILENAME);
  }

  // ─── Read operations (Stage 1) ───

  /** Read current state. Returns default state if file doesn't exist. */
  readState(): RunState {
    if (!fs.existsSync(this.statePath)) {
      return defaultState();
    }
    const raw = fs.readFileSync(this.statePath, 'utf-8');
    return JSON.parse(raw) as RunState;
  }

  /** Read approval policy. Returns empty policy if file doesn't exist. */
  readPolicy(): ApprovalPolicy {
    if (!fs.existsSync(this.policyPath)) {
      return {};
    }
    const raw = fs.readFileSync(this.policyPath, 'utf-8');
    return JSON.parse(raw) as ApprovalPolicy;
  }

  /** Check if the run is in a terminal state. */
  isTerminal(state: RunState): boolean {
    return ['completed', 'failed', 'rejected'].includes(state.run_status);
  }

  /** Check if the run has a pending approval that has timed out. */
  isApprovalTimedOut(state: RunState): boolean {
    const pending = state.pending_approval;
    if (!pending?.timeout_at) return false;
    try {
      const deadline = new Date(pending.timeout_at);
      return Date.now() > deadline.getTime();
    } catch {
      return false;
    }
  }

  /** Check if the approval budget is exhausted.
   *  Reads budgets.max_approvals from the policy (matching Python path). */
  isApprovalBudgetExhausted(state: RunState): boolean {
    const policy = this.readPolicy();
    const maxApprovals = policy.budgets?.max_approvals ?? 0;
    if (maxApprovals <= 0) return false;
    const approvedCount = state.approval_history.filter(
      (h) => h.decision === 'approved',
    ).length;
    return approvedCount >= maxApprovals;
  }

  /** Get a summary of the current run status. */
  statusSummary(state: RunState): Record<string, unknown> {
    return {
      run_id: state.run_id,
      workflow_id: state.workflow_id,
      run_status: state.run_status,
      current_step: state.current_step,
      pending_approval: state.pending_approval
        ? {
            approval_id: state.pending_approval.approval_id,
            category: state.pending_approval.category,
            timed_out: this.isApprovalTimedOut(state),
          }
        : null,
      approvals_used: state.approval_history.filter((h) => h.decision === 'approved').length,
      notes: state.notes || undefined,
    };
  }

  // ─── Write operations (Stage 2) ───

  /** Ensure the runtime directory and empty ledger exist. */
  ensureDirs(): void {
    if (!fs.existsSync(this.dir)) {
      fs.mkdirSync(this.dir, { recursive: true });
    }
    if (!fs.existsSync(this.ledgerPath)) {
      fs.writeFileSync(this.ledgerPath, '', 'utf-8');
    }
  }

  /** Atomic write of state.json. Matches Python save_state().
   *  Does NOT handle plan validation/plan.md derivation (Python remains plan SSOT). */
  saveState(state: RunState): void {
    writeJsonAtomic(this.statePath, state as unknown as Record<string, unknown>);
  }

  /** Append a ledger event. */
  appendLedger(
    eventType: string,
    opts?: {
      run_id?: string | null;
      workflow_id?: string | null;
      step_id?: string | null;
      details?: Record<string, unknown>;
    },
  ): void {
    this.ensureDirs();
    appendLedgerLine(this.ledgerPath, {
      ts: utcNowIso(),
      event_type: eventType,
      run_id: opts?.run_id ?? null,
      workflow_id: opts?.workflow_id ?? null,
      step_id: opts?.step_id ?? null,
      details: opts?.details ?? {},
    });
  }

  /** Atomically save state + append ledger event.
   *  Matches Python persist_state_with_ledger_event (staged .next → ledger → replace). */
  saveStateWithLedger(
    state: RunState,
    eventType: string,
    opts?: {
      step_id?: string | null;
      details?: Record<string, unknown>;
    },
  ): void {
    this.ensureDirs();

    // 1. Stage state to .next
    const staged = this.statePath + '.next';
    writeJsonAtomic(staged, state as unknown as Record<string, unknown>);

    // 2. Append ledger
    try {
      appendLedgerLine(this.ledgerPath, {
        ts: utcNowIso(),
        event_type: eventType,
        run_id: state.run_id,
        workflow_id: state.workflow_id,
        step_id: opts?.step_id ?? null,
        details: opts?.details ?? {},
      });
    } catch (e) {
      // Cleanup staged file on ledger failure
      try { fs.unlinkSync(staged); } catch { /* best-effort */ }
      throw e;
    }

    // 3. Commit: rename staged → final
    try {
      fs.renameSync(staged, this.statePath);
    } catch (e) {
      throw new Error(
        `failed to commit state after ledger write; staged=${staged}; error=${e}`,
      );
    }
  }

  /** Validate and execute a status transition.
   *  Throws if the transition is not allowed. */
  transitionStatus(
    state: RunState,
    newStatus: RunStatus,
    opts?: { notes?: string; details?: Record<string, unknown>; eventType?: string },
  ): void {
    const current = state.run_status;
    const allowed = VALID_TRANSITIONS[current] ?? [];
    if (!allowed.includes(newStatus)) {
      throw new Error(
        `invalid status transition: ${current} → ${newStatus} (allowed: ${allowed.join(', ') || 'none'})`,
      );
    }

    state.run_status = newStatus;
    if (opts?.notes !== undefined) {
      state.notes = opts.notes;
    }

    const eventType = opts?.eventType ?? `status_${newStatus}`;
    this.saveStateWithLedger(state, eventType, {
      step_id: state.current_step?.step_id ?? null,
      details: { from: current, to: newStatus, ...opts?.details },
    });
  }

  // ─── Checkpoint management (Stage 3a) ───

  /** Update the checkpoint timestamp. Matches Python: st["checkpoints"]["last_checkpoint_at"] = _now_z() */
  updateCheckpoint(state: RunState): void {
    state.checkpoints.last_checkpoint_at = utcNowIso();
    this.saveState(state);
  }

  /** Check whether a checkpoint is due (elapsed > interval).
   *  Note: Python maybe_mark_needs_recovery uses 2×interval (stricter recovery threshold);
   *  this method uses 1×interval for general checkpoint scheduling. */
  isCheckpointDue(state: RunState): boolean {
    const last = state.checkpoints.last_checkpoint_at;
    const interval = state.checkpoints.checkpoint_interval_seconds;
    if (!last || interval <= 0) return false;
    try {
      const lastMs = new Date(last).getTime();
      return Date.now() - lastMs > interval * 1000;
    } catch {
      return false;
    }
  }

  // ─── High-level state operations ───

  /** orch_run_create: Initialize a new run from idle state. */
  createRun(
    state: RunState,
    runId: string,
    workflowId: string,
  ): void {
    if (state.run_status !== 'idle') {
      throw new Error(`cannot create run: current status is '${state.run_status}', expected 'idle'`);
    }
    state.run_id = runId;
    state.workflow_id = workflowId;
    this.transitionStatus(state, 'running', {
      notes: `run created: ${runId}`,
      details: { run_id: runId, workflow_id: workflowId },
      eventType: 'run_started',
    });
  }

  /** orch_run_approve: Approve a pending approval and resume the run. */
  approveRun(
    state: RunState,
    approvalId: string,
    note?: string,
  ): void {
    if (state.run_status !== 'awaiting_approval') {
      throw new Error(
        `cannot approve: current status is '${state.run_status}', expected 'awaiting_approval'`,
      );
    }
    const pending = state.pending_approval;
    if (!pending || pending.approval_id !== approvalId) {
      throw new Error(
        `approval_id mismatch: expected '${pending?.approval_id}', got '${approvalId}'`,
      );
    }

    const entry: ApprovalHistoryEntry = {
      ts: utcNowIso(),
      approval_id: approvalId,
      category: pending.category,
      decision: 'approved',
      note: note ?? '',
    };
    state.approval_history.push(entry);
    // Python uses category as key: st["gate_satisfied"][str(category)] = approval_id
    state.gate_satisfied[pending.category] = approvalId;
    state.pending_approval = null;
    // Checkpoint heartbeat on approve (matching Python cmd_approve)
    state.checkpoints.last_checkpoint_at = utcNowIso();

    this.transitionStatus(state, 'running', {
      notes: `approval ${approvalId} granted`,
      details: { approval_id: approvalId, category: pending.category, note: note ?? '' },
      eventType: 'approval_approved',
    });
  }

  /** orch_run_reject: Reject a pending approval. Transitions to paused (matching Python cmd_reject).
   *  Note: 'rejected' terminal status is reserved for auto-rejection on timeout (Python check_approval_timeout). */
  rejectRun(
    state: RunState,
    approvalId: string,
    note?: string,
  ): void {
    if (state.run_status !== 'awaiting_approval') {
      throw new Error(
        `cannot reject: current status is '${state.run_status}', expected 'awaiting_approval'`,
      );
    }
    const pending = state.pending_approval;
    if (!pending || pending.approval_id !== approvalId) {
      throw new Error(
        `approval_id mismatch: expected '${pending?.approval_id}', got '${approvalId}'`,
      );
    }

    const entry: ApprovalHistoryEntry = {
      ts: utcNowIso(),
      approval_id: approvalId,
      category: pending.category,
      decision: 'rejected',
      note: note ?? '',
    };
    state.approval_history.push(entry);
    state.pending_approval = null;

    this.transitionStatus(state, 'paused', {
      notes: `rejected ${approvalId}${note ? ': ' + note : ''}`,
      details: { approval_id: approvalId, category: pending.category, note: note ?? '' },
      eventType: 'approval_rejected',
    });
  }

  /** orch_run_pause: Pause a running run.
   *  Cannot pause while awaiting_approval — use rejectRun instead (matching Python cmd_pause guard). */
  pauseRun(state: RunState): void {
    if (state.run_status === 'awaiting_approval') {
      throw new Error(
        'cannot pause: run is awaiting_approval; use rejectRun to decline and pause',
      );
    }
    this.transitionStatus(state, 'paused', {
      notes: 'run paused by user',
      eventType: 'paused',
    });
  }

  /** orch_run_resume: Resume a paused or blocked run.
   *  Refuses resume while pending_approval exists (matching Python cmd_resume guard). */
  resumeRun(state: RunState): void {
    if (state.pending_approval) {
      throw new Error(
        `cannot resume: pending_approval exists (${state.pending_approval.approval_id}); approve or reject first`,
      );
    }
    // Checkpoint heartbeat on resume (matching Python cmd_resume)
    state.checkpoints.last_checkpoint_at = utcNowIso();
    this.transitionStatus(state, 'running', {
      notes: `run resumed from ${state.run_status}`,
      eventType: 'resumed',
    });
  }

  /** Generate the next approval ID for a category (matching Python next_approval_id). */
  nextApprovalId(state: RunState, category: string): string {
    const seq = (state.approval_seq[category] ?? 0) + 1;
    state.approval_seq[category] = seq;
    return `${category}-${String(seq).padStart(4, '0')}`;
  }

  /** orch_run_request_approval: Create a pending approval gate.
   *  Matches Python _request_approval state-mutation logic.
   *  Packet rendering is caller responsibility; only packet_path is recorded. */
  requestApproval(
    state: RunState,
    category: string,
    opts: {
      plan_step_ids?: string[];
      packet_path: string;
      note?: string;
      force?: boolean;
    },
  ): string {
    if (state.pending_approval && !opts.force) {
      throw new Error(
        `already awaiting approval: ${state.pending_approval.approval_id}`,
      );
    }
    if (state.run_status !== 'running') {
      throw new Error(
        `cannot request approval: current status is '${state.run_status}', expected 'running'`,
      );
    }

    const approvalId = this.nextApprovalId(state, category);
    const policy = this.readPolicy();
    // Python uses APPROVAL_CATEGORY_TO_POLICY_KEY to map A1→mass_search, etc.
    const policyKey = APPROVAL_CATEGORY_TO_POLICY_KEY[category] ?? category;
    const timeoutCfg = policy.timeouts?.[policyKey] ?? { timeout_seconds: 86400, on_timeout: 'block' };
    const timeoutSeconds = timeoutCfg.timeout_seconds ?? 0;
    const onTimeout = timeoutCfg.on_timeout ?? 'block';

    const requestedAt = utcNowIso();
    let timeoutAt: string | null = null;
    if (timeoutSeconds > 0) {
      const deadline = new Date(new Date(requestedAt).getTime() + timeoutSeconds * 1000);
      timeoutAt = deadline.toISOString().replace(/\.\d{3}Z$/, 'Z');
    }

    const stepIds = (opts.plan_step_ids ?? []).filter((s) => s.trim());
    if (stepIds.length === 0 && state.current_step?.step_id) {
      stepIds.push(state.current_step.step_id);
    }

    state.pending_approval = {
      approval_id: approvalId,
      category,
      plan_step_ids: stepIds,
      requested_at: requestedAt,
      timeout_at: timeoutAt,
      on_timeout: onTimeout,
      packet_path: opts.packet_path,
    };
    state.notes = opts.note ?? `awaiting approval ${approvalId}`;

    this.transitionStatus(state, 'awaiting_approval', {
      details: { approval_id: approvalId, category, packet_path: opts.packet_path },
      eventType: 'approval_requested',
    });

    return approvalId;
  }
}
