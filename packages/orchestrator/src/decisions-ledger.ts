import * as fs from 'node:fs';
import * as path from 'node:path';
import { closeSync, openSync, readFileSync, rmSync, statSync, writeSync } from 'node:fs';
import { appendJsonlDurable, writeBytesAtomicDurable } from '@nullius/shared';
import { utcNowIso } from './util.js';

/** Append-only ledger of human decisions made in conversation.
 *
 *  Real projects resolve most questions conversationally ("use option 2",
 *  "confirmed, no change") and the outcome historically landed in hand-built
 *  markdown ledgers the engine never saw. This file is the engine-visible
 *  bookkeeping stratum of those decisions: one JSON line per event, sequential
 *  ids matching the D1, D2, ... convention those ledgers already used. The
 *  free-prose question documents stay project-owned; nothing here parses them.
 *
 *  Recording never gates anything: open decisions surface in the status
 *  receipt as information, not as a blocking state. */

export type DecisionKind = 'decided' | 'pending';

export type DecisionRecord = {
  /** Sequential "D<n>" id; never reused, survives interleaved kinds. */
  id: string;
  /** UTC ISO timestamp. */
  ts: string;
  kind: DecisionKind;
  /** What was decided (kind=decided) or what awaits a decision (kind=pending). */
  text: string;
  /** Who decided / who is being asked. Defaults to "user" at the CLI. */
  by: string;
  /** For kind=decided: id of the open pending entry this decision closes. */
  resolves: string | null;
};

export type DecisionsLedgerSnapshot = {
  /** Project-relative POSIX path of the ledger file. */
  path: string;
  exists: boolean;
  records: DecisionRecord[];
  /** Lines that failed to parse or lacked required fields; never fatal. */
  invalid_lines: number;
};

const DECISION_ID_PATTERN = /^D(\d+)$/;

// Bounded wait for the cross-process append lock: 100 x 25ms = 2.5s covers
// any realistic holder (one read + one appended line), then fail loudly.
const LOCK_RETRY_ATTEMPTS = 100;
const LOCK_RETRY_SLEEP_MS = 25;

export function decisionsLedgerRelativePath(): string {
  return path.join('.nullius', 'decisions.jsonl').split(path.sep).join('/');
}

export function decisionsLedgerPath(projectRoot: string): string {
  return path.join(projectRoot, '.nullius', 'decisions.jsonl');
}

/** Parse an id like "D7" to its safe-integer sequence number, else null.
 *  Rejects unsafe integers so a manually added absurd id cannot corrupt
 *  subsequent allocation via float rounding. */
function decisionSequenceNumber(id: unknown): number | null {
  if (typeof id !== 'string') return null;
  const match = DECISION_ID_PATTERN.exec(id);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

function parseDecisionLine(line: string): DecisionRecord | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  if (decisionSequenceNumber(record.id) === null) return null;
  if (typeof record.ts !== 'string') return null;
  if (record.kind !== 'decided' && record.kind !== 'pending') return null;
  if (typeof record.text !== 'string' || record.text.length === 0) return null;
  return {
    id: record.id as string,
    ts: record.ts,
    kind: record.kind,
    text: record.text,
    by: typeof record.by === 'string' && record.by.length > 0 ? record.by : 'user',
    resolves: decisionSequenceNumber(record.resolves) !== null ? record.resolves as string : null,
  };
}

export function readDecisionsLedger(projectRoot: string): DecisionsLedgerSnapshot {
  const filePath = decisionsLedgerPath(projectRoot);
  const relativePath = decisionsLedgerRelativePath();
  if (!fs.existsSync(filePath)) {
    return { path: relativePath, exists: false, records: [], invalid_lines: 0 };
  }
  const records: DecisionRecord[] = [];
  let invalidLines = 0;
  const lines = fs.readFileSync(filePath, 'utf-8').split(/\r?\n/);
  for (const line of lines) {
    if (line.trim().length === 0) continue;
    const record = parseDecisionLine(line);
    if (record) {
      records.push(record);
    } else {
      invalidLines += 1;
    }
  }
  return { path: relativePath, exists: true, records, invalid_lines: invalidLines };
}

/** Pending entries not closed by any later decided entry. Oldest first. */
export function openDecisions(records: DecisionRecord[]): DecisionRecord[] {
  const resolved = new Set(
    records
      .filter((record) => record.kind === 'decided' && record.resolves !== null)
      .map((record) => record.resolves as string),
  );
  return records.filter((record) => record.kind === 'pending' && !resolved.has(record.id));
}

function nextDecisionId(records: DecisionRecord[]): string {
  let highest = 0;
  for (const record of records) {
    const value = decisionSequenceNumber(record.id);
    if (value !== null && value > highest) highest = value;
  }
  return `D${highest + 1}`;
}

function lockFilePath(projectRoot: string): string {
  return `${decisionsLedgerPath(projectRoot)}.lock`;
}

function holderAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // ESRCH: provably dead. EPERM: exists but not ours — alive. Anything
    // else: assume alive (never reclaim on uncertainty).
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

/** Reclaims a provably stale lock (holder dead, or unreadable and old).
 *  Returns true when reclaimed so the acquire loop can retry immediately. */
function reclaimStaleLock(lockPath: string): boolean {
  let holderPid: number | null = null;
  try {
    const content = JSON.parse(readFileSync(lockPath, 'utf-8')) as Record<string, unknown>;
    if (typeof content.pid === 'number' && Number.isInteger(content.pid) && content.pid > 0) {
      holderPid = content.pid;
    }
  } catch {
    holderPid = null;
  }
  if (holderPid !== null) {
    if (holderAlive(holderPid)) return false;
    rmSync(lockPath, { force: true });
    return true;
  }
  try {
    // Unreadable/empty lock: a live acquirer writes its pid within
    // milliseconds of creating the file, so a short grace period suffices.
    if (Date.now() - statSync(lockPath).mtimeMs > 5000) {
      rmSync(lockPath, { force: true });
      return true;
    }
  } catch {
    return true; // vanished between EEXIST and stat: just retry
  }
  return false;
}

function sleepBlocking(ms: number): void {
  const shared = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(shared), 0, 0, ms);
}

/** Cross-process mutual exclusion around read-allocate-append, so two CLI
 *  processes recording concurrently cannot allocate the same D<n>. The lock
 *  file carries the holder pid (control metadata, not durable project data). */
function withDecisionsLock<T>(projectRoot: string, action: () => T): T {
  const lockPath = lockFilePath(projectRoot);
  let acquired = false;
  for (let attempt = 0; attempt < LOCK_RETRY_ATTEMPTS; attempt += 1) {
    try {
      const fd = openSync(lockPath, 'wx');
      try {
        writeSync(fd, JSON.stringify({ pid: process.pid, ts: utcNowIso() }));
      } finally {
        closeSync(fd);
      }
      acquired = true;
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (reclaimStaleLock(lockPath)) continue;
      sleepBlocking(LOCK_RETRY_SLEEP_MS);
    }
  }
  if (!acquired) {
    throw new Error(`decisions ledger is locked by another process (${lockPath}); retry in a moment`);
  }
  try {
    return action();
  } finally {
    rmSync(lockPath, { force: true });
  }
}

/** A hand edit or an interrupted foreign write can leave the last line
 *  without a trailing newline; blindly appending would concatenate the new
 *  record onto it, corrupting BOTH lines. Repair the boundary first with an
 *  atomic full-file replace (contents preserved byte-for-byte plus one LF). */
function repairUnterminatedTail(filePath: string): void {
  if (!fs.existsSync(filePath)) return;
  const bytes = fs.readFileSync(filePath);
  if (bytes.length === 0) return;
  if (bytes[bytes.length - 1] === 0x0a) return;
  writeBytesAtomicDurable(filePath, Buffer.concat([bytes, Buffer.from('\n')]));
}

export function appendDecision(
  projectRoot: string,
  params: { kind: DecisionKind; text: string; by?: string | null; resolves?: string | null },
): DecisionRecord {
  const trimmed = params.text.trim();
  if (trimmed.length === 0) {
    throw new Error('decision text must not be empty');
  }
  const runtimeDir = path.join(projectRoot, '.nullius');
  if (!fs.existsSync(runtimeDir)) {
    throw new Error('project is not initialized (missing .nullius/); run nullius init first');
  }
  return withDecisionsLock(projectRoot, () => {
    const filePath = decisionsLedgerPath(projectRoot);
    repairUnterminatedTail(filePath);
    const snapshot = readDecisionsLedger(projectRoot);
    let resolves: string | null = null;
    if (params.resolves) {
      if (params.kind !== 'decided') {
        throw new Error('--resolves is only valid when recording a decision');
      }
      const target = snapshot.records.find((record) => record.id === params.resolves);
      if (!target) {
        throw new Error(`--resolves ${params.resolves} does not match any recorded decision id`);
      }
      if (target.kind !== 'pending') {
        throw new Error(`--resolves ${params.resolves} points at a decided entry; only pending entries can be resolved`);
      }
      if (!openDecisions(snapshot.records).some((record) => record.id === target.id)) {
        throw new Error(`--resolves ${params.resolves} is already resolved; only open pending entries can be resolved`);
      }
      resolves = target.id;
    }
    const record: DecisionRecord = {
      id: nextDecisionId(snapshot.records),
      ts: utcNowIso(),
      kind: params.kind,
      text: trimmed,
      by: params.by && params.by.trim().length > 0 ? params.by.trim() : 'user',
      resolves,
    };
    appendJsonlDurable(filePath, record);
    return record;
  });
}
