// @nullius/orchestrator — durable delegated-runtime tool attempts.

import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { withLedgerLock, writeJsonAtomicDurable } from '@nullius/shared';
import type { McpToolResult } from './mcp-jsonrpc.js';
import { utcNowIso } from './util.js';

export const RUN_MANIFEST_VERSION = 2 as const;

export interface ToolAttemptIdentity {
  step_id: string;
  tool_name: string;
  input_sha256: string;
}

export interface ToolApprovalBoundary {
  authority: 'run_gate';
  gate_id: string;
  run_id: string;
  approval_id: string;
  packet_path: string;
  approval_packet_sha256: string;
}

export interface PendingToolIntent extends ToolAttemptIdentity {
  state: 'not_started' | 'outcome_unknown';
  observed_at: string;
  dispatch_intent_at?: string;
  approval_boundary_count: number;
  last_approval_boundary?: ToolApprovalBoundary & { recorded_at: string };
}

export interface PersistedToolOutcome {
  ok: boolean;
  is_error: boolean;
  raw_text: string;
  json: unknown | null;
  error_code: string | null;
}

export interface StepCheckpoint extends ToolAttemptIdentity {
  completed_at: string;
  result_sha256: string;
  outcome: PersistedToolOutcome;
  approval_boundary_count: number;
  last_approval_boundary?: ToolApprovalBoundary & { recorded_at: string };
}

export interface RunManifest {
  manifest_version: typeof RUN_MANIFEST_VERSION;
  run_id: string;
  created_at: string;
  last_completed_step?: string;
  resume_from?: string;
  pending_tool_intents: PendingToolIntent[];
  checkpoints: StepCheckpoint[];
}

export type ToolAttemptClassification =
  | { state: 'missing'; identity: ToolAttemptIdentity }
  | { state: 'not_started'; identity: ToolAttemptIdentity }
  | { state: 'outcome_unknown'; identity: ToolAttemptIdentity }
  | { state: 'committed'; identity: ToolAttemptIdentity; result: McpToolResult; result_sha256: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function canonicalJsonInner(value: unknown, active: Set<object>): string {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('canonical JSON rejects non-finite numbers');
    return JSON.stringify(value);
  }
  if (typeof value !== 'object') {
    throw new Error(`canonical JSON rejects ${typeof value} values`);
  }
  if (active.has(value)) throw new Error('canonical JSON rejects cyclic values');
  active.add(value);
  try {
    if (Array.isArray(value)) {
      return `[${value.map(item => canonicalJsonInner(item, active)).join(',')}]`;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error('canonical JSON accepts only plain objects');
    }
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map(key => `${JSON.stringify(key)}:${canonicalJsonInner(record[key], active)}`)
      .join(',')}}`;
  } finally {
    active.delete(value);
  }
}

export function canonicalJson(value: unknown): string {
  return canonicalJsonInner(value, new Set<object>());
}

function sha256Text(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function sha256CanonicalJson(value: unknown): string {
  return sha256Text(canonicalJson(value));
}

function persistedOutcome(result: McpToolResult): PersistedToolOutcome {
  return {
    ok: result.ok,
    is_error: result.isError,
    raw_text: result.rawText,
    json: result.json,
    error_code: result.errorCode,
  };
}

export function sha256McpToolResult(result: McpToolResult): string {
  return sha256CanonicalJson(persistedOutcome(result));
}

export function createToolAttemptIdentity(params: {
  stepId: string;
  toolName: string;
  input: unknown;
}): ToolAttemptIdentity {
  if (!params.stepId.trim()) throw new Error('tool attempt step_id must not be empty');
  if (!params.toolName.trim()) throw new Error('tool attempt tool_name must not be empty');
  return {
    step_id: params.stepId,
    tool_name: params.toolName,
    input_sha256: sha256CanonicalJson(params.input),
  };
}

function assertIdentityMatches(
  actual: ToolAttemptIdentity,
  expected: ToolAttemptIdentity,
  context: string,
): void {
  if (actual.step_id !== expected.step_id
    || actual.tool_name !== expected.tool_name
    || actual.input_sha256 !== expected.input_sha256) {
    throw new Error(
      `${context}: tool-attempt identity conflict for step ${expected.step_id}`,
    );
  }
}

function assertString(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`invalid run manifest: ${field} must be a non-empty string`);
  }
}

function assertNullableString(value: unknown, field: string): asserts value is string | null {
  if (value !== null && typeof value !== 'string') {
    throw new Error(`invalid run manifest: ${field} must be a string or null`);
  }
}

function assertSha256(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/i.test(value)) {
    throw new Error(`invalid run manifest: ${field} must be a SHA-256 digest`);
  }
}

function assertSafeRunId(runId: string): void {
  if (!/^[A-Za-z0-9._-]+$/.test(runId) || runId === '.' || runId.includes('..')) {
    throw new Error(`invalid delegated runtime run_id: ${runId}`);
  }
}

function assertProjectRelativePath(value: string, field: string): void {
  if (value.startsWith('/')
    || value.startsWith('\\')
    || /^[a-zA-Z]:[\\/]/.test(value)
    || value.split(/[\\/]/).includes('..')) {
    throw new Error(`invalid run manifest: ${field} must be a project-relative path without traversal`);
  }
}

function validateIdentity(value: unknown, field: string): asserts value is ToolAttemptIdentity {
  if (!isRecord(value)) throw new Error(`invalid run manifest: ${field} must be an object`);
  assertString(value['step_id'], `${field}.step_id`);
  assertString(value['tool_name'], `${field}.tool_name`);
  assertSha256(value['input_sha256'], `${field}.input_sha256`);
}

function validateApprovalBoundary(value: unknown, field: string): void {
  if (!isRecord(value)) throw new Error(`invalid run manifest: ${field} must be an object`);
  if (value['authority'] !== 'run_gate') {
    throw new Error(`invalid run manifest: ${field}.authority must be run_gate`);
  }
  const gateId = value['gate_id'];
  const boundaryRunId = value['run_id'];
  const approvalId = value['approval_id'];
  const packetPath = value['packet_path'];
  const recordedAt = value['recorded_at'];
  assertString(gateId, `${field}.gate_id`);
  assertString(boundaryRunId, `${field}.run_id`);
  assertString(approvalId, `${field}.approval_id`);
  assertString(packetPath, `${field}.packet_path`);
  assertString(recordedAt, `${field}.recorded_at`);
  if (!/^A[1-5]$/.test(gateId)) {
    throw new Error(`invalid run manifest: ${field}.gate_id must be A1 through A5`);
  }
  assertSafeRunId(boundaryRunId);
  assertProjectRelativePath(packetPath, `${field}.packet_path`);
  assertSha256(value['approval_packet_sha256'], `${field}.approval_packet_sha256`);
}

function validateManifest(value: unknown): RunManifest {
  if (!isRecord(value)) throw new Error('invalid run manifest: root must be an object');
  if (value['manifest_version'] !== RUN_MANIFEST_VERSION) {
    throw new Error(
      'unsupported delegated runtime manifest: automatic recovery requires manifest_version 2',
    );
  }
  assertString(value['run_id'], 'run_id');
  assertSafeRunId(value['run_id']);
  assertString(value['created_at'], 'created_at');
  if (value['last_completed_step'] !== undefined) {
    assertString(value['last_completed_step'], 'last_completed_step');
  }
  if (value['resume_from'] !== undefined) assertString(value['resume_from'], 'resume_from');
  if (!Array.isArray(value['pending_tool_intents'])) {
    throw new Error('invalid run manifest: pending_tool_intents must be an array');
  }
  if (!Array.isArray(value['checkpoints'])) {
    throw new Error('invalid run manifest: checkpoints must be an array');
  }

  const seenPending = new Set<string>();
  for (const [index, pending] of value['pending_tool_intents'].entries()) {
    const field = `pending_tool_intents[${index}]`;
    validateIdentity(pending, field);
    const pendingRecord = pending as unknown as Record<string, unknown>;
    if (seenPending.has(pending.step_id)) {
      throw new Error(`invalid run manifest: duplicate pending step_id ${pending.step_id}`);
    }
    seenPending.add(pending.step_id);
    if (pendingRecord['state'] !== 'not_started' && pendingRecord['state'] !== 'outcome_unknown') {
      throw new Error(`invalid run manifest: ${field}.state is unsupported`);
    }
    assertString(pendingRecord['observed_at'], `${field}.observed_at`);
    if (!Number.isInteger(pendingRecord['approval_boundary_count']) || Number(pendingRecord['approval_boundary_count']) < 0) {
      throw new Error(`invalid run manifest: ${field}.approval_boundary_count must be a non-negative integer`);
    }
    if (pendingRecord['state'] === 'outcome_unknown') {
      assertString(pendingRecord['dispatch_intent_at'], `${field}.dispatch_intent_at`);
    } else if (pendingRecord['dispatch_intent_at'] !== undefined) {
      throw new Error(`invalid run manifest: ${field}.dispatch_intent_at is only valid for outcome_unknown`);
    }
    if (pendingRecord['last_approval_boundary'] !== undefined) {
      validateApprovalBoundary(pendingRecord['last_approval_boundary'], `${field}.last_approval_boundary`);
    }
    if ((Number(pendingRecord['approval_boundary_count']) === 0)
      !== (pendingRecord['last_approval_boundary'] === undefined)) {
      throw new Error(
        `invalid run manifest: ${field}.approval_boundary_count and last_approval_boundary disagree`,
      );
    }
  }

  const seenCommitted = new Set<string>();
  for (const [index, checkpoint] of value['checkpoints'].entries()) {
    const field = `checkpoints[${index}]`;
    validateIdentity(checkpoint, field);
    const checkpointRecord = checkpoint as unknown as Record<string, unknown>;
    if (seenCommitted.has(checkpoint.step_id)) {
      throw new Error(`invalid run manifest: duplicate committed step_id ${checkpoint.step_id}`);
    }
    if (seenPending.has(checkpoint.step_id)) {
      throw new Error(`invalid run manifest: step ${checkpoint.step_id} is both pending and committed`);
    }
    seenCommitted.add(checkpoint.step_id);
    assertString(checkpointRecord['completed_at'], `${field}.completed_at`);
    assertSha256(checkpointRecord['result_sha256'], `${field}.result_sha256`);
    const outcome = checkpointRecord['outcome'];
    if (!isRecord(outcome)) throw new Error(`invalid run manifest: ${field}.outcome must be an object`);
    if (typeof outcome['ok'] !== 'boolean' || typeof outcome['is_error'] !== 'boolean') {
      throw new Error(`invalid run manifest: ${field}.outcome status fields must be boolean`);
    }
    if (typeof outcome['raw_text'] !== 'string') {
      throw new Error(`invalid run manifest: ${field}.outcome.raw_text must be a string`);
    }
    assertNullableString(outcome['error_code'], `${field}.outcome.error_code`);
    canonicalJson(outcome['json']);
    if (!Number.isInteger(checkpointRecord['approval_boundary_count'])
      || Number(checkpointRecord['approval_boundary_count']) < 0) {
      throw new Error(`invalid run manifest: ${field}.approval_boundary_count must be a non-negative integer`);
    }
    if (checkpointRecord['last_approval_boundary'] !== undefined) {
      validateApprovalBoundary(checkpointRecord['last_approval_boundary'], `${field}.last_approval_boundary`);
    }
    if ((Number(checkpointRecord['approval_boundary_count']) === 0)
      !== (checkpointRecord['last_approval_boundary'] === undefined)) {
      throw new Error(
        `invalid run manifest: ${field}.approval_boundary_count and last_approval_boundary disagree`,
      );
    }
    const calculated = sha256CanonicalJson({
      ok: outcome['ok'],
      is_error: outcome['is_error'],
      raw_text: outcome['raw_text'],
      json: outcome['json'],
      error_code: outcome['error_code'],
    });
    if (calculated !== checkpointRecord['result_sha256']) {
      throw new Error(`invalid run manifest: ${field}.result_sha256 does not match outcome`);
    }
  }
  if (value['last_completed_step'] !== undefined && !seenCommitted.has(value['last_completed_step'])) {
    throw new Error('invalid run manifest: last_completed_step is not a committed checkpoint');
  }
  return value as unknown as RunManifest;
}

function resultFromCheckpoint(checkpoint: StepCheckpoint): McpToolResult {
  return {
    ok: checkpoint.outcome.ok,
    isError: checkpoint.outcome.is_error,
    rawText: checkpoint.outcome.raw_text,
    json: checkpoint.outcome.json,
    errorCode: checkpoint.outcome.error_code,
  };
}

export class RunManifestManager {
  constructor(private readonly runsDir: string) {}

  private manifestPath(runId: string): string {
    assertSafeRunId(runId);
    return path.join(this.runsDir, runId, 'manifest.json');
  }

  ensureManifest(runId: string): RunManifest {
    return this.withManifestLock(runId, () => this.ensureManifestUnlocked(runId));
  }

  loadManifest(runId: string): RunManifest | null {
    const manifestPath = this.manifestPath(runId);
    if (!fs.existsSync(manifestPath)) return null;
    const manifest = validateManifest(JSON.parse(fs.readFileSync(manifestPath, 'utf-8')));
    if (manifest.run_id !== runId) {
      throw new Error(`invalid run manifest: expected run_id ${runId}, received ${manifest.run_id}`);
    }
    return manifest;
  }

  observeToolIntents(runId: string, attempts: ReadonlyArray<ToolAttemptIdentity>): void {
    this.withManifestLock(runId, () => {
      const manifest = this.ensureManifestUnlocked(runId);
      const batchIds = new Set<string>();
      for (const attempt of attempts) {
        validateIdentity(attempt, 'tool_attempt');
        if (batchIds.has(attempt.step_id)) {
          throw new Error(`duplicate tool attempt in observation batch: ${attempt.step_id}`);
        }
        batchIds.add(attempt.step_id);
        const pending = manifest.pending_tool_intents.find(item => item.step_id === attempt.step_id);
        const committed = manifest.checkpoints.find(item => item.step_id === attempt.step_id);
        if (pending) assertIdentityMatches(pending, attempt, 'observe tool intent');
        if (committed) assertIdentityMatches(committed, attempt, 'observe committed tool intent');
        if (!pending && !committed) {
          manifest.pending_tool_intents.push({
            ...attempt,
            state: 'not_started',
            observed_at: utcNowIso(),
            approval_boundary_count: 0,
          });
        }
      }
      this.writeManifest(manifest);
    });
  }

  markToolIntentsDispatched(runId: string, attempts: ReadonlyArray<ToolAttemptIdentity>): void {
    this.withManifestLock(runId, () => {
      const manifest = this.requireManifest(runId);
      const batchIds = new Set<string>();
      const pendingItems = attempts.map(attempt => {
        validateIdentity(attempt, 'tool_attempt');
        if (batchIds.has(attempt.step_id)) {
          throw new Error(`duplicate tool attempt in dispatch batch: ${attempt.step_id}`);
        }
        batchIds.add(attempt.step_id);
        const pending = manifest.pending_tool_intents.find(item => item.step_id === attempt.step_id);
        if (!pending) throw new Error(`cannot dispatch missing tool intent: ${attempt.step_id}`);
        assertIdentityMatches(pending, attempt, 'dispatch tool intent');
        if (pending.state !== 'not_started') {
          throw new Error(
            `cannot dispatch tool intent already owned by another execution: ${attempt.step_id}`,
          );
        }
        return pending;
      });
      const dispatchedAt = utcNowIso();
      for (const pending of pendingItems) {
        pending.state = 'outcome_unknown';
        pending.dispatch_intent_at = dispatchedAt;
      }
      this.writeManifest(manifest);
    });
  }

  commitToolAttempt(runId: string, attempt: ToolAttemptIdentity, result: McpToolResult): void {
    this.withManifestLock(runId, () => {
      const manifest = this.requireManifest(runId);
      const existing = manifest.checkpoints.find(item => item.step_id === attempt.step_id);
      const resultSha256 = sha256McpToolResult(result);
      if (existing) {
        assertIdentityMatches(existing, attempt, 'commit tool result');
        if (existing.result_sha256 !== resultSha256) {
          throw new Error(`commit tool result conflict for step ${attempt.step_id}`);
        }
        return;
      }
      const pendingIndex = manifest.pending_tool_intents.findIndex(item => item.step_id === attempt.step_id);
      if (pendingIndex < 0) throw new Error(`cannot commit missing tool intent: ${attempt.step_id}`);
      const pending = manifest.pending_tool_intents[pendingIndex]!;
      assertIdentityMatches(pending, attempt, 'commit tool result');
      if (pending.state !== 'outcome_unknown') {
        throw new Error(`cannot commit tool result before durable dispatch intent: ${attempt.step_id}`);
      }
      manifest.pending_tool_intents.splice(pendingIndex, 1);
      manifest.checkpoints.push({
        ...attempt,
        completed_at: utcNowIso(),
        result_sha256: resultSha256,
        outcome: persistedOutcome(result),
        approval_boundary_count: pending.approval_boundary_count,
        ...(pending.last_approval_boundary
          ? { last_approval_boundary: { ...pending.last_approval_boundary } }
          : {}),
      });
      manifest.last_completed_step = attempt.step_id;
      this.writeManifest(manifest);
    });
  }

  resetOutcomeUnknownAtApprovalBoundary(
    runId: string,
    attempt: ToolAttemptIdentity,
    boundary: ToolApprovalBoundary,
  ): void {
    this.withManifestLock(runId, () => {
      const manifest = this.requireManifest(runId);
      const pending = manifest.pending_tool_intents.find(item => item.step_id === attempt.step_id);
      if (!pending) throw new Error(`cannot record approval boundary for missing tool intent: ${attempt.step_id}`);
      assertIdentityMatches(pending, attempt, 'record approval boundary');
      if (pending.state !== 'outcome_unknown') {
        throw new Error(`approval boundary requires outcome_unknown state: ${attempt.step_id}`);
      }
      const recordedAt = utcNowIso();
      validateApprovalBoundary({ ...boundary, recorded_at: recordedAt }, 'approval_boundary');
      pending.state = 'not_started';
      delete pending.dispatch_intent_at;
      pending.approval_boundary_count += 1;
      pending.last_approval_boundary = { ...boundary, recorded_at: recordedAt };
      this.writeManifest(manifest);
    });
  }

  classifyToolAttempt(runId: string, attempt: ToolAttemptIdentity): ToolAttemptClassification {
    const manifest = this.loadManifest(runId);
    if (!manifest) return { state: 'missing', identity: attempt };
    const pending = manifest.pending_tool_intents.find(item => item.step_id === attempt.step_id);
    if (pending) {
      assertIdentityMatches(pending, attempt, 'classify tool intent');
      return { state: pending.state, identity: attempt };
    }
    const checkpoint = manifest.checkpoints.find(item => item.step_id === attempt.step_id);
    if (checkpoint) {
      assertIdentityMatches(checkpoint, attempt, 'classify committed tool attempt');
      return {
        state: 'committed',
        identity: attempt,
        result: resultFromCheckpoint(checkpoint),
        result_sha256: checkpoint.result_sha256,
      };
    }
    return { state: 'missing', identity: attempt };
  }

  classifyToolAttempts(
    runId: string,
    attempts: ReadonlyArray<ToolAttemptIdentity>,
  ): ToolAttemptClassification[] {
    const manifest = this.loadManifest(runId);
    if (!manifest) return attempts.map(identity => ({ state: 'missing', identity }));
    return attempts.map(attempt => {
      const pending = manifest.pending_tool_intents.find(item => item.step_id === attempt.step_id);
      if (pending) {
        assertIdentityMatches(pending, attempt, 'classify tool intent');
        return { state: pending.state, identity: attempt };
      }
      const checkpoint = manifest.checkpoints.find(item => item.step_id === attempt.step_id);
      if (checkpoint) {
        assertIdentityMatches(checkpoint, attempt, 'classify committed tool attempt');
        return {
          state: 'committed',
          identity: attempt,
          result: resultFromCheckpoint(checkpoint),
          result_sha256: checkpoint.result_sha256,
        };
      }
      return { state: 'missing', identity: attempt };
    });
  }

  shouldSkipStep(manifest: RunManifest, stepId: string): boolean {
    if (!manifest.resume_from) return false;
    return manifest.checkpoints.some(checkpoint => checkpoint.step_id === stepId);
  }

  private requireManifest(runId: string): RunManifest {
    const manifest = this.loadManifest(runId);
    if (!manifest) throw new Error(`missing delegated runtime manifest for run ${runId}`);
    return manifest;
  }

  private ensureManifestUnlocked(runId: string): RunManifest {
    const existing = this.loadManifest(runId);
    if (existing) return existing;
    const manifest: RunManifest = {
      manifest_version: RUN_MANIFEST_VERSION,
      run_id: runId,
      created_at: utcNowIso(),
      pending_tool_intents: [],
      checkpoints: [],
    };
    this.writeManifest(manifest);
    return manifest;
  }

  private withManifestLock<T>(runId: string, action: () => T): T {
    const manifestPath = this.manifestPath(runId);
    fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
    return withLedgerLock(
      manifestPath,
      'confirm no delegated runtime writer owns this run manifest',
      action,
    );
  }

  private writeManifest(manifest: RunManifest): void {
    validateManifest(manifest);
    writeJsonAtomicDurable(this.manifestPath(manifest.run_id), manifest);
  }
}
