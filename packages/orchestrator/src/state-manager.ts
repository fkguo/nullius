// @autoresearch/orchestrator — StateManager (NEW-05a Stage 3c)
// Read + write + enforcement + sentinel + plan validation operations. Compatible with Python orchestrator_state.py.
// Atomic writes: .tmp → rename (H-07 pre-requisite).

import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  APPROVAL_GATE_IDS,
  getApprovalPolicyKey,
} from '@autoresearch/shared';
import type { RunState, RunStatus, ApprovalPolicy, ApprovalHistoryEntry, LedgerEvent } from './types.js';
import { sortKeysRecursive, utcNowIso } from './util.js';

const AUTORESEARCH_DIRNAME = '.autoresearch';
const AUTORESEARCH_CONTROL_DIR_ENV = 'AUTORESEARCH_CONTROL_DIR';
const STATE_FILENAME = 'state.json';
const LEDGER_FILENAME = 'ledger.jsonl';
const APPROVAL_POLICY_FILENAME = 'approval_policy.json';
const PLAN_MD_FILENAME = 'plan.md';

/** Valid plan step statuses (matching Python plan.schema.json). */

/** Check if value is a plain object (not null, not array). Matches Python isinstance(x, dict). */
function isDict(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

// ─── Embedded plan schema + recursive validator (matching Python _schema_validate) ───

/** Embedded plan.schema.json (current checked-in source: packages/hep-autoresearch/specs/plan.schema.json).
 *  Embedded to avoid cross-package file dependency. Must be kept in sync. */
const PLAN_SCHEMA: Record<string, unknown> = {
  type: 'object',
  required: ['schema_version', 'created_at', 'updated_at', 'steps'],
  properties: {
    schema_version: { type: 'integer', minimum: 1 },
    created_at: { type: 'string' },
    updated_at: { type: 'string' },
    plan_id: { type: 'string' },
    run_id: { type: 'string' },
    workflow_id: { type: 'string' },
    current_step_id: { type: 'string' },
    branching: { oneOf: [{ $ref: '#/$defs/plan_branching' }, { type: 'null' }] },
    steps: { type: 'array', items: { $ref: '#/$defs/plan_step' } },
    notes: { type: 'string' },
  },
  additionalProperties: false,
  $defs: {
    approval_category: { type: 'string', enum: APPROVAL_GATE_IDS },
    branch_status: { type: 'string', enum: ['candidate', 'active', 'abandoned', 'failed', 'completed'] },
    branch_candidate: {
      type: 'object',
      required: ['branch_id', 'label', 'description', 'status', 'expected_approvals', 'expected_outputs', 'recovery_notes'],
      properties: {
        branch_id: { type: 'string', minLength: 1 },
        label: { type: 'string', minLength: 1 },
        description: { type: 'string', minLength: 1 },
        status: { $ref: '#/$defs/branch_status' },
        expected_approvals: { type: 'array', items: { $ref: '#/$defs/approval_category' } },
        expected_outputs: { type: 'array', items: { type: 'string', minLength: 1 } },
        recovery_notes: { type: 'string' },
        created_at: { oneOf: [{ type: 'string' }, { type: 'null' }] },
        updated_at: { oneOf: [{ type: 'string' }, { type: 'null' }] },
      },
      additionalProperties: false,
    },
    branch_decision: {
      type: 'object',
      required: ['decision_id', 'title', 'step_id', 'created_at', 'updated_at', 'max_branches', 'active_branch_id', 'branches', 'notes'],
      properties: {
        decision_id: { type: 'string', minLength: 1 },
        title: { type: 'string', minLength: 1 },
        step_id: { type: 'string', minLength: 1 },
        created_at: { type: 'string' },
        updated_at: { type: 'string' },
        max_branches: { type: 'integer', minimum: 1 },
        cap_override: { oneOf: [{ type: 'integer', minimum: 1 }, { type: 'null' }] },
        active_branch_id: { oneOf: [{ type: 'string', minLength: 1 }, { type: 'null' }] },
        branches: { type: 'array', items: { $ref: '#/$defs/branch_candidate' } },
        notes: { type: 'string' },
      },
      additionalProperties: false,
    },
    plan_branching: {
      type: 'object',
      required: ['schema_version', 'active_branch_id', 'max_branches_per_decision', 'decisions', 'notes'],
      properties: {
        schema_version: { type: 'integer', minimum: 1 },
        active_branch_id: { oneOf: [{ type: 'string', minLength: 1 }, { type: 'null' }] },
        max_branches_per_decision: { type: 'integer', minimum: 1 },
        decisions: { type: 'array', items: { $ref: '#/$defs/branch_decision' } },
        notes: { type: 'string' },
      },
      additionalProperties: false,
    },
    plan_step: {
      type: 'object',
      required: ['step_id', 'description', 'status', 'expected_approvals', 'expected_outputs', 'recovery_notes'],
      properties: {
        step_id: { type: 'string', minLength: 1 },
        description: { type: 'string', minLength: 1 },
        status: { type: 'string', enum: ['pending', 'in_progress', 'completed', 'blocked', 'failed', 'skipped'] },
        expected_approvals: { type: 'array', items: { $ref: '#/$defs/approval_category' } },
        expected_outputs: { type: 'array', items: { type: 'string', minLength: 1 } },
        recovery_notes: { type: 'string' },
        started_at: { oneOf: [{ type: 'string' }, { type: 'null' }] },
        completed_at: { oneOf: [{ type: 'string' }, { type: 'null' }] },
      },
      additionalProperties: false,
    },
  },
};

/** Resolve a $ref pointer (e.g. "#/$defs/plan_step") against the root schema.
 *  Matches Python _schema_resolve_ref: filters empty tokens, unescapes ~1/~0, handles array indices. */
function schemaResolveRef(rootSchema: Record<string, unknown>, ref: string): Record<string, unknown> | null {
  if (!ref.startsWith('#/')) return null;
  const tokens = ref.slice(2).split('/').filter((t) => t !== '');
  let cur: unknown = rootSchema;
  for (const raw of tokens) {
    const t = raw.replace(/~1/g, '/').replace(/~0/g, '~');
    if (Array.isArray(cur)) {
      if (!/^-?\d+$/.test(t)) return null;
      let idx = Number(t);
      if (idx < 0) idx = cur.length + idx;
      if (idx < 0 || idx >= cur.length) return null;
      cur = cur[idx];
    } else if (isDict(cur)) {
      if (!(t in cur)) return null;
      cur = cur[t];
    } else {
      return null;
    }
  }
  return isDict(cur) ? cur : null;
}

/** Check if payload matches a JSON Schema type string. Matches Python _schema_type_ok. */
function schemaTypeOk(payload: unknown, t: string): boolean {
  if (t === 'object') return isDict(payload);
  if (t === 'array') return Array.isArray(payload);
  if (t === 'string') return typeof payload === 'string';
  if (t === 'integer') return typeof payload === 'number' && Number.isInteger(payload);
  if (t === 'number') return typeof payload === 'number';
  if (t === 'boolean') return typeof payload === 'boolean';
  if (t === 'null') return payload === null;
  return true;
}

/** Minimal recursive JSON Schema subset validator.
 *  Matches Python _schema_validate (orchestrator_state.py L181-267).
 *  Supports: type, required, properties, items, enum, minimum, minLength, oneOf, $ref, additionalProperties. */
function schemaValidate(
  payload: unknown,
  schema: Record<string, unknown>,
  pathStr: string,
  rootSchema: Record<string, unknown>,
): string[] {
  const errors: string[] = [];
  if (!isDict(schema)) return errors;

  // $ref
  if ('$ref' in schema) {
    const ref = schema.$ref;
    if (typeof ref !== 'string') return [`${pathStr}: $ref must be a string`];
    const target = schemaResolveRef(rootSchema, ref);
    if (!target) return [`${pathStr}: could not resolve $ref '${ref}'`];
    return schemaValidate(payload, target, pathStr, rootSchema);
  }

  // oneOf
  if ('oneOf' in schema) {
    const opts = schema.oneOf;
    if (!Array.isArray(opts) || opts.length === 0) return [`${pathStr}: schema.oneOf must be a non-empty list`];
    let bestErrs: string[] | null = null;
    for (const opt of opts) {
      if (!isDict(opt)) continue;
      const subErrs = schemaValidate(payload, opt, pathStr, rootSchema);
      if (subErrs.length === 0) return [];
      if (bestErrs === null || subErrs.length < bestErrs.length) bestErrs = subErrs;
    }
    errors.push(`${pathStr}: does not satisfy any schema in oneOf`);
    if (bestErrs) errors.push(...bestErrs.slice(0, 5));
    return errors;
  }

  const schemaType = schema.type;
  if (typeof schemaType === 'string' && !schemaTypeOk(payload, schemaType)) {
    return [`${pathStr}: expected type ${schemaType}, got ${typeof payload}`];
  }

  // enum
  if ('enum' in schema && Array.isArray(schema.enum)) {
    if (!schema.enum.includes(payload)) {
      errors.push(`${pathStr}: value '${payload}' not in enum`);
    }
  }

  // minimum
  if (typeof schemaType === 'string' && (schemaType === 'integer' || schemaType === 'number') && 'minimum' in schema) {
    if (typeof payload === 'number' && typeof schema.minimum === 'number' && payload < schema.minimum) {
      errors.push(`${pathStr}: value ${payload} < minimum ${schema.minimum}`);
    }
  }

  // minLength
  if (typeof schemaType === 'string' && schemaType === 'string' && 'minLength' in schema) {
    if (typeof payload === 'string' && typeof schema.minLength === 'number' && payload.length < schema.minLength) {
      errors.push(`${pathStr}: string shorter than minLength ${schema.minLength}`);
    }
  }

  // object: required, properties, additionalProperties
  if (typeof schemaType === 'string' && schemaType === 'object') {
    const required = Array.isArray(schema.required) ? schema.required : [];
    for (const k of required) {
      if (typeof k !== 'string') continue;
      if (!isDict(payload) || !(k in payload)) {
        errors.push(`${pathStr}: missing required field ${k}`);
      }
    }
    const props = isDict(schema.properties) ? schema.properties as Record<string, unknown> : {};
    if (isDict(payload)) {
      for (const [k, subschema] of Object.entries(props)) {
        if (!(k in payload)) continue;
        if (isDict(subschema)) {
          errors.push(...schemaValidate(payload[k], subschema, `${pathStr}.${k}`, rootSchema));
        }
      }
      if (schema.additionalProperties === false) {
        const allowed = new Set(Object.keys(props));
        const extra = Object.keys(payload).filter((k) => !allowed.has(k));
        if (extra.length > 0) {
          errors.push(`${pathStr}: unexpected properties ${extra.sort().join(', ')}`);
        }
      }
    }
  }

  // array: items
  if (typeof schemaType === 'string' && schemaType === 'array' && 'items' in schema) {
    const items = schema.items;
    if (isDict(items) && Array.isArray(payload)) {
      for (let i = 0; i < Math.min(payload.length, 200); i++) {
        errors.push(...schemaValidate(payload[i], items, `${pathStr}[${i}]`, rootSchema));
      }
    }
  }

  return errors;
}

function approvalSequenceTemplate(): Record<string, number> {
  return Object.fromEntries(
    APPROVAL_GATE_IDS.map((gateId) => [gateId, 0] as const),
  ) as Record<string, number>;
}

function autoresearchDir(repoRoot: string): string {
  const override = process.env[AUTORESEARCH_CONTROL_DIR_ENV];
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
    approval_seq: approvalSequenceTemplate(),
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
  paused: ['running', 'blocked', 'needs_recovery'],
  awaiting_approval: ['running', 'paused', 'rejected', 'blocked', 'needs_recovery'],
  blocked: ['running', 'paused', 'failed'],
  needs_recovery: ['running', 'paused', 'failed'],
  completed: [],
  failed: [],
  rejected: [],
};

export class StateManager {
  private readonly dir: string;
  private readonly repoRoot: string;

  constructor(repoRoot: string) {
    this.repoRoot = repoRoot;
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
            agent_id: 'root',
            assignment_id: null,
            session_id: null,
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
   *  Validates plan and derives plan.md when plan is present. */
  saveState(state: RunState): void {
    const plan = state.plan;
    if (isDict(plan)) {
      this.validatePlan(plan);
      state.plan_md_path = this.planMdRelativePath;
    }
    writeJsonAtomic(this.statePath, state as unknown as Record<string, unknown>);
    if (isDict(plan)) {
      // SSOT-first: state.json already persisted, now derive plan.md
      this.writePlanMd(plan);
    }
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
   *  Matches Python persist_state_with_ledger_event (staged .next → ledger → replace).
   *  Validates plan and derives plan.md when plan is present. */
  saveStateWithLedger(
    state: RunState,
    eventType: string,
    opts?: {
      step_id?: string | null;
      details?: Record<string, unknown>;
    },
  ): void {
    this.ensureDirs();

    // 0. Plan validation + plan_md_path (Stage 3c)
    const plan = state.plan;
    if (isDict(plan)) {
      this.validatePlan(plan);
      state.plan_md_path = this.planMdRelativePath;
    }

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

    // 4. Derive plan.md (after state is safely persisted — SSOT-first)
    if (isDict(plan)) {
      this.writePlanMd(plan);
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
    // Only inject {from,to} for synthetic status_* events (no explicit eventType).
    // Python ledger entries with explicit event types write only the details passed at callsite.
    const details = opts?.eventType
      ? (opts?.details ?? {})
      : { from: current, to: newStatus, ...opts?.details };
    this.saveStateWithLedger(state, eventType, {
      step_id: state.current_step?.step_id ?? null,
      details,
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
      details: { note: '' },
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
   *  Also writes .pause sentinel (matching Python cmd_reject L1649).
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

    // Write .pause sentinel (matching Python cmd_reject L1649)
    this.writePauseSentinel();

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

  /** orch_run_pause: Pause a run from any status.
   *  Writes .pause sentinel and saves paused_from_status (matching Python cmd_pause L728-749).
   *  Python allows pausing from ANY status — no transition validation. */
  pauseRun(state: RunState, note?: string): void {
    // Write .pause sentinel (matching Python cmd_pause L732)
    this.writePauseSentinel();
    // Save original status for resume (matching Python cmd_pause L735-736)
    if (state.run_status !== 'paused') {
      state.paused_from_status = state.run_status;
    }
    state.run_status = 'paused';
    state.notes = note ?? 'paused by user';
    // Persist directly (bypass transitionStatus — Python sets run_status verbatim)
    this.saveStateWithLedger(state, 'paused', {
      step_id: state.current_step?.step_id ?? null,
      details: { note: note ?? '' },
    });
  }

  /** orch_run_resume: Resume a paused or blocked run.
   *  Removes .pause sentinel and restores paused_from_status (matching Python cmd_resume L752-780).
   *  Bypasses transitionStatus to faithfully restore any saved status (Python sets run_status verbatim).
   *  Refuses resume while pending_approval exists (matching Python cmd_resume guard). */
  resumeRun(state: RunState, opts?: { note?: string; force?: boolean }): void {
    if (state.pending_approval) {
      throw new Error(
        `cannot resume: pending_approval exists (${state.pending_approval.approval_id}); approve or reject first`,
      );
    }
    // Remove .pause sentinel BEFORE the idle guard (matching Python cmd_resume L760-761)
    this.removePauseSentinel();
    // Guard against resume from terminal/idle without force (matching Python cmd_resume L763-764)
    if (['idle', 'completed', 'failed'].includes(state.run_status) && !opts?.force) {
      throw new Error(
        `cannot resume from status=${state.run_status} (use start or --force)`,
      );
    }
    // Restore original status from paused_from_status (matching Python cmd_resume L766-767)
    const restored = state.paused_from_status;
    delete state.paused_from_status;
    state.run_status = restored ?? 'running';
    state.notes = opts?.note ?? 'resumed by user';
    // Checkpoint heartbeat on resume (matching Python cmd_resume L769)
    state.checkpoints.last_checkpoint_at = utcNowIso();
    // Persist directly (bypass transitionStatus — Python does not validate transitions on resume)
    this.saveStateWithLedger(state, 'resumed', {
      step_id: state.current_step?.step_id ?? null,
      details: { note: opts?.note ?? '' },
    });
  }

  // ─── Sentinel file management (Stage 3b) ───

  /** Check for .pause / .stop sentinel files at repo root.
   *  Matches Python _check_stop_pause (orchestrator_cli.py L1675-1680). */
  checkStopPause(): 'stop' | 'pause' | null {
    if (fs.existsSync(path.join(this.repoRoot, '.stop'))) return 'stop';
    if (fs.existsSync(path.join(this.repoRoot, '.pause'))) return 'pause';
    return null;
  }

  /** Write .pause sentinel file at repo root (matching Python cmd_pause L732). */
  writePauseSentinel(): void {
    fs.writeFileSync(path.join(this.repoRoot, '.pause'), 'paused\n', 'utf-8');
  }

  /** Remove .pause sentinel file at repo root (best-effort, matching Python cmd_resume L760-761). */
  removePauseSentinel(): void {
    try {
      const p = path.join(this.repoRoot, '.pause');
      if (fs.existsSync(p)) fs.unlinkSync(p);
    } catch { /* best-effort */ }
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
    const policyKey = getApprovalPolicyKey(category) ?? category;
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

  // ─── Enforcement operations (Stage 3b) ───

  /** Enforce approval timeout with side effects.
   *  Returns the on_timeout action string if timed out, or null if not.
   *  Matches Python check_approval_timeout (orchestrator_state.py L702-766). */
  enforceApprovalTimeout(state: RunState): string | null {
    const pending = state.pending_approval;
    if (!pending?.timeout_at) return null;

    let deadline: number;
    try {
      deadline = new Date(pending.timeout_at).getTime();
      if (isNaN(deadline)) return null;
    } catch {
      return null;
    }
    if (Date.now() <= deadline) return null;

    const onTimeout = pending.on_timeout || 'block';
    const approvalId = pending.approval_id;

    if (onTimeout === 'reject') {
      state.pending_approval = null;
      state.run_status = 'rejected';
      state.notes = `approval ${approvalId} timed out — auto-rejected`;
      state.approval_history.push({
        ts: utcNowIso(),
        approval_id: approvalId,
        category: pending.category,
        decision: 'timeout_rejected',
        note: `auto-rejected: timed out at ${pending.timeout_at}`,
      });
    } else if (onTimeout === 'escalate') {
      state.run_status = 'needs_recovery';
      state.notes = `approval ${approvalId} timed out — escalated`;
    } else {
      // 'block' (default)
      state.run_status = 'blocked';
      state.notes = `approval ${approvalId} timed out — blocked`;
    }

    this.saveStateWithLedger(state, 'approval_timeout', {
      step_id: state.current_step?.step_id ?? null,
      details: {
        approval_id: approvalId,
        policy_action: onTimeout,
        timeout_at: pending.timeout_at,
      },
    });

    return onTimeout;
  }

  /** Enforce approval budget with side effects.
   *  Returns true if budget is exhausted (and state is updated), false otherwise.
   *  Matches Python check_approval_budget (orchestrator_state.py L769-814). */
  enforceApprovalBudget(state: RunState): boolean {
    const policy = this.readPolicy();
    const maxApprovals = policy.budgets?.max_approvals ?? 0;
    if (maxApprovals <= 0) return false;

    const granted = state.approval_history.filter(
      (h) => h.decision === 'approved',
    ).length;
    if (granted < maxApprovals) return false;

    state.run_status = 'blocked';
    state.notes = `approval budget exhausted (${granted}/${maxApprovals})`;
    if (state.pending_approval) {
      state.pending_approval = null;
    }

    this.saveStateWithLedger(state, 'approval_budget_exhausted', {
      step_id: state.current_step?.step_id ?? null,
      details: { granted, max_approvals: maxApprovals },
    });

    return true;
  }

  /** Full checkpoint command.
   *  Matches Python cmd_checkpoint (orchestrator_cli.py L783-815).
   *  Includes _sync_plan_current_step integration (Stage 3c). */
  checkpoint(
    state: RunState,
    opts?: {
      step_id?: string;
      step_title?: string;
      note?: string;
      force?: boolean;
    },
  ): { action?: string } {
    // Status guard
    const allowed: RunStatus[] = ['running', 'paused', 'awaiting_approval'];
    if (!allowed.includes(state.run_status) && !opts?.force) {
      throw new Error(
        `refusing checkpoint in status=${state.run_status} (use --force)`,
      );
    }

    // Timeout enforcement (C-01)
    const timeoutAction = this.enforceApprovalTimeout(state);
    if (timeoutAction) {
      return { action: `approval_timeout:${timeoutAction}` };
    }

    // Budget enforcement (C-01)
    if (this.enforceApprovalBudget(state)) {
      return { action: 'budget_exhausted' };
    }

    // Step tracking
    if (opts?.step_id || opts?.step_title) {
      const stepId = opts.step_id ?? state.current_step?.step_id ?? 'STEP';
      const title = opts.step_title ?? state.current_step?.title ?? '';
      state.current_step = { step_id: stepId, title, started_at: utcNowIso() };
    }

    // Plan step sync (matching Python _sync_plan_current_step)
    if (opts?.step_id && state.plan && isDict(state.plan)) {
      this.syncPlanCurrentStep(state, opts.step_id, opts.step_title ?? '');
    }

    // Timestamp
    state.checkpoints.last_checkpoint_at = utcNowIso();

    // Persist
    this.saveStateWithLedger(state, 'checkpoint', {
      step_id: state.current_step?.step_id ?? null,
      details: { note: opts?.note ?? '' },
    });

    return {};
  }

  // ─── Plan validation + derivation (Stage 3c) ───

  /** Path to plan.md within .autoresearch dir. */
  get planMdPath(): string {
    return path.join(this.dir, PLAN_MD_FILENAME);
  }

  /** Relative path to plan.md from repoRoot (matching Python plan_md_path().relative_to(repo_root)).
   *  Falls back to absolute path if plan.md is outside repoRoot (e.g. AUTORESEARCH_CONTROL_DIR override). */
  get planMdRelativePath(): string {
    const p = this.planMdPath;
    const rel = path.relative(this.repoRoot, p);
    // If relative path escapes repo root, return absolute
    if (rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) return p;
    return rel;
  }

  /** Validate plan structure and branching cross-field invariants.
   *  Matches Python validate_plan (orchestrator_state.py L270-371).
   *  Throws on invalid. */
  validatePlan(plan: Record<string, unknown>): void {
    // §1a — Schema validation (matching Python _schema_validate recursive coverage)
    const schemaErrors = schemaValidate(plan, PLAN_SCHEMA, 'plan', PLAN_SCHEMA);
    if (schemaErrors.length > 0) {
      throw new Error('plan schema validation failed:\n' + schemaErrors.slice(0, 15).join('\n'));
    }

    // §1b — Branching cross-field invariants (matching Python L281-371)
    const branching = plan.branching;
    if (branching === undefined || branching === null) return;
    if (typeof branching !== 'object' || Array.isArray(branching)) {
      throw new Error('plan.branching must be an object or null');
    }
    const br = branching as Record<string, unknown>;

    // Collect step_ids
    const stepIds = new Set<string>();
    if (Array.isArray(plan.steps)) {
      for (const s of plan.steps) {
        if (!s || typeof s !== 'object' || Array.isArray(s)) continue;
        const sid = String((s as Record<string, unknown>).step_id ?? '').trim();
        if (sid) stepIds.add(sid);
      }
    }

    const decisions = br.decisions;
    if (!Array.isArray(decisions)) return;

    const activePairs: Array<[string, string]> = [];
    const seenDecisionIds = new Set<string>();

    for (const dec of decisions) {
      if (!dec || typeof dec !== 'object' || Array.isArray(dec)) continue;
      const d = dec as Record<string, unknown>;

      // 1. decision_id uniqueness
      const decisionId = String(d.decision_id ?? '').trim();
      if (decisionId) {
        if (seenDecisionIds.has(decisionId)) {
          throw new Error(`duplicate branch_decision decision_id: ${decisionId}`);
        }
        seenDecisionIds.add(decisionId);
      }

      // 2. decision.step_id reference integrity
      const decisionStepId = String(d.step_id ?? '').trim();
      if (decisionStepId && !stepIds.has(decisionStepId)) {
        throw new Error(
          `branch_decision ${decisionId}: step_id '${decisionStepId}' not found in plan.steps`,
        );
      }

      // 3. branch_id uniqueness within decision
      const branches = Array.isArray(d.branches) ? d.branches : [];
      const branchesDicts = branches.filter(
        (b): b is Record<string, unknown> => !!b && typeof b === 'object' && !Array.isArray(b),
      );
      const seenBranchIds = new Set<string>();
      for (const branch of branchesDicts) {
        const bid = String(branch.branch_id ?? '').trim();
        if (!bid) continue;
        if (seenBranchIds.has(bid)) {
          throw new Error(`branch_decision ${decisionId}: duplicate branch_id: ${bid}`);
        }
        seenBranchIds.add(bid);
      }

      // 4. decision.active_branch_id → must point to existing active branch
      const activeDec = d.active_branch_id;
      if (activeDec !== undefined && activeDec !== null) {
        const s = String(activeDec).trim();
        if (!s) {
          throw new Error(
            `branch_decision ${decisionId || '(missing)'}: active_branch_id must be non-empty or null`,
          );
        }
        let target: Record<string, unknown> | null = null;
        for (const branch of branchesDicts) {
          if (String(branch.branch_id ?? '').trim() === s) {
            target = branch;
            break;
          }
        }
        if (!target) {
          throw new Error(
            `branch_decision ${decisionId}: active_branch_id '${s}' not found in branches`,
          );
        }
        if (String(target.status ?? '').trim() !== 'active') {
          throw new Error(
            `branch_decision ${decisionId}: active_branch_id '${s}' must have status 'active'`,
          );
        }
      }

      // 5. Single active branch constraint
      const activeInDec = branchesDicts
        .filter((b) => String(b.status ?? '').trim() === 'active')
        .map((b) => String(b.branch_id ?? '').trim())
        .filter((x) => x);

      if (activeInDec.length > 1) {
        throw new Error(
          `branch_decision ${decisionId}: multiple active branches: ${[...activeInDec].sort().join(', ')}`,
        );
      }

      // 6. Active branch ↔ decision.active_branch_id consistency
      if (activeInDec.length === 1) {
        const bid = activeInDec[0];
        if (String(d.active_branch_id ?? '').trim() !== bid) {
          throw new Error(
            `branch_decision ${decisionId}: branch '${bid}' marked active but decision.active_branch_id is '${d.active_branch_id ?? ''}'`,
          );
        }
        activePairs.push([decisionId, bid]);
      }
    }

    // 7. Global branching.active_branch_id
    const activeGlobal = br.active_branch_id;
    if (activeGlobal !== undefined && activeGlobal !== null) {
      const s = String(activeGlobal).trim();
      if (!s) {
        throw new Error('plan.branching.active_branch_id must be non-empty or null');
      }
      if ((s.match(/:/g) ?? []).length !== 1) {
        throw new Error(
          "plan.branching.active_branch_id must be a composite '<decision_id>:<branch_id>'",
        );
      }
      const [did, bid] = s.split(':', 2).map((p) => p.trim());
      if (!did || !bid) {
        throw new Error(
          "plan.branching.active_branch_id must be a composite '<decision_id>:<branch_id>'",
        );
      }
      if (activePairs.length === 0) {
        throw new Error(
          "plan.branching.active_branch_id is set but no branch candidate has status 'active' (decision.active_branch_id mismatch)",
        );
      }
      if (!activePairs.some(([d, b]) => d === did && b === bid)) {
        throw new Error(
          `plan.branching.active_branch_id '${s}' points to a branch that is not active in its decision`,
        );
      }
    }
  }

  /** Render plan to Markdown string.
   *  Matches Python render_plan_md (orchestrator_state.py L390-475). */
  renderPlanMd(plan: Record<string, unknown>): string {
    let steps = plan.steps;
    if (!Array.isArray(steps)) steps = [];

    const branching = (typeof plan.branching === 'object' && plan.branching !== null && !Array.isArray(plan.branching))
      ? plan.branching as Record<string, unknown>
      : null;

    const runId = plan.run_id ?? null;
    const workflowId = plan.workflow_id ?? null;
    const updatedAt = plan.updated_at ?? null;

    const lines: string[] = [];
    lines.push('# Plan (derived view)');
    lines.push('');
    lines.push(`- Run: ${runId || '(unknown)'}`);
    lines.push(`- Workflow: ${workflowId || '(unknown)'}`);
    if (updatedAt) {
      lines.push(`- Updated: ${updatedAt}`);
    }
    lines.push('');
    lines.push('SSOT: `.autoresearch/state.json#/plan`');
    lines.push('');
    lines.push('## Steps');
    lines.push('');

    let idx = 0;
    for (const rawStep of steps as unknown[]) {
      idx++;
      if (!rawStep || typeof rawStep !== 'object' || Array.isArray(rawStep)) continue;
      const step = rawStep as Record<string, unknown>;
      const stepId = String(step.step_id || '').trim();
      const desc = String(step.description || '').trim();
      const status = String(step.status || '').trim();
      let approvals = step.expected_approvals;
      if (!Array.isArray(approvals)) approvals = [];
      const approvalsStr = (approvals as unknown[])
        .filter((a) => a)
        .map((a) => String(a))
        .join(', ') || '-';
      lines.push(`${idx}. [${status || 'pending'}] ${stepId} — ${desc}`);
      lines.push(`   - expected_approvals: ${approvalsStr}`);
      const outs = step.expected_outputs;
      if (Array.isArray(outs) && outs.length > 0) {
        lines.push('   - expected_outputs:');
        for (const o of outs) {
          if (o) lines.push(`     - ${o}`);
        }
      }
      const rec = String(step.recovery_notes || '').trim();
      if (rec) {
        lines.push(`   - recovery_notes: ${rec}`);
      }
    }

    if (branching) {
      lines.push('');
      lines.push('## Branching');
      lines.push('');
      const active = String(branching.active_branch_id || '').trim() || '-';
      const maxPer = branching.max_branches_per_decision;
      const maxPerStr = maxPer !== undefined && maxPer !== null ? String(maxPer) : '-';
      lines.push(`- active_branch_id: ${active}`);
      lines.push(`- max_branches_per_decision: ${maxPerStr}`);

      const decisions = branching.decisions;
      if (Array.isArray(decisions) && decisions.length > 0) {
        lines.push('');
        lines.push('### Decisions');
        lines.push('');
        let didx = 0;
        for (const rawDec of decisions) {
          didx++;
          if (!rawDec || typeof rawDec !== 'object' || Array.isArray(rawDec)) continue;
          const dec = rawDec as Record<string, unknown>;
          const decisionId = String(dec.decision_id || '').trim() || 'DECISION';
          const title = String(dec.title || '').trim() || '(missing title)';
          const stepId = String(dec.step_id || '').trim() || '-';
          lines.push(`${didx}. ${decisionId} — ${title}`);
          lines.push(`   - step_id: ${stepId}`);
          lines.push(`   - max_branches: ${dec.max_branches}`);
          if (dec.cap_override !== undefined && dec.cap_override !== null) {
            lines.push(`   - cap_override: ${dec.cap_override}`);
          }
          const activeBranch = String(dec.active_branch_id || '').trim() || '-';
          lines.push(`   - active_branch_id: ${activeBranch}`);
          const decBranches = dec.branches;
          if (Array.isArray(decBranches) && decBranches.length > 0) {
            lines.push('   - branches:');
            for (const rawBr of decBranches) {
              if (!rawBr || typeof rawBr !== 'object' || Array.isArray(rawBr)) continue;
              const branch = rawBr as Record<string, unknown>;
              const bid = String(branch.branch_id || '').trim() || 'BRANCH';
              const label = String(branch.label || '').trim() || bid;
              const bStatus = String(branch.status || '').trim() || 'candidate';
              const bDesc = String(branch.description || '').trim() || '(missing description)';
              lines.push(`     - [${bStatus}] ${bid} — ${label}: ${bDesc}`);
            }
          }
        }
      }
    }

    lines.push('');
    return lines.join('\n');
  }

  /** Validate plan, render to Markdown, and atomically write to .autoresearch/plan.md.
   *  Matches Python write_plan_md (orchestrator_state.py L478-495).
   *  Returns relative path. */
  writePlanMd(plan: Record<string, unknown>): string {
    this.validatePlan(plan);
    this.ensureDirs();
    const content = this.renderPlanMd(plan);
    const p = this.planMdPath;
    const tmp = p + '.tmp';
    fs.writeFileSync(tmp, content, 'utf-8');
    try {
      fs.renameSync(tmp, p);
    } catch (e) {
      try { fs.unlinkSync(tmp); } catch { /* best-effort cleanup */ }
      throw e;
    }
    return this.planMdRelativePath;
  }

  /** Sync plan.current_step_id to a new step.
   *  Matches Python _sync_plan_current_step (orchestrator_cli.py L1955-1999). */
  syncPlanCurrentStep(state: RunState, stepId: string, title: string): void {
    const plan = state.plan;
    if (!isDict(plan)) return;

    const now = utcNowIso();
    plan.updated_at = now;
    plan.current_step_id = String(stepId);

    let steps: unknown[] = plan.steps as unknown[];
    if (!Array.isArray(plan.steps)) {
      steps = [];
      plan.steps = steps;
    }

    let found = false;
    for (const rawStep of steps) {
      if (!rawStep || typeof rawStep !== 'object' || Array.isArray(rawStep)) continue;
      const step = rawStep as Record<string, unknown>;
      if (String(step.step_id) === String(stepId)) {
        found = true;
        if (step.status !== 'in_progress') {
          step.status = 'in_progress';
        }
        if (!step.started_at) {
          step.started_at = now;
        }
        step.completed_at = null;
        if (!step.description) {
          step.description = String(title).trim() || '(missing description)';
        }
      } else if (step.status === 'in_progress') {
        step.status = 'completed';
        if (!step.completed_at) {
          step.completed_at = now;
        }
      }
    }

    if (!found) {
      steps.push(
        makePlanStep(String(stepId), String(title), 'in_progress', now, null),
      );
    }
    // plan_md_path is derived and written on saveState / saveStateWithLedger
  }

  /** Sync a plan step to terminal status.
   *  Matches Python _sync_plan_terminal (orchestrator_cli.py L2002-2039). */
  syncPlanTerminal(state: RunState, stepId: string, title: string, status: string): void {
    const plan = state.plan;
    if (!isDict(plan)) return;

    const now = utcNowIso();
    plan.updated_at = now;

    let steps: unknown[] = plan.steps as unknown[];
    if (!Array.isArray(plan.steps)) {
      steps = [];
      plan.steps = steps;
    }

    let found = false;
    for (const rawStep of steps) {
      if (!rawStep || typeof rawStep !== 'object' || Array.isArray(rawStep)) continue;
      const step = rawStep as Record<string, unknown>;
      if (String(step.step_id) !== String(stepId)) continue;
      found = true;
      step.status = String(status);
      if (status === 'completed' || status === 'failed') {
        if (!step.completed_at) {
          step.completed_at = now;
        }
      }
      if (!step.description) {
        step.description = String(title).trim() || '(missing description)';
      }
    }

    if (!found) {
      steps.push(
        makePlanStep(
          String(stepId),
          String(title),
          String(status),
          null,
          (status === 'completed' || status === 'failed') ? now : null,
        ),
      );
    }
    // plan_md_path is derived and written on saveState / saveStateWithLedger
  }
}

/** Build a plan step object matching Python _plan_step (orchestrator_cli.py L1692-1717). */
function makePlanStep(
  stepId: string,
  description: string,
  status: string,
  startedAt: string | null,
  completedAt: string | null,
): Record<string, unknown> {
  const sid = stepId.trim() || 'STEP';
  const desc = description.trim() || '(missing description)';
  const st = status.trim() || 'pending';
  return {
    step_id: sid,
    description: desc,
    status: st,
    expected_approvals: [],
    expected_outputs: [],
    recovery_notes: '',
    started_at: startedAt,
    completed_at: completedAt,
  };
}
