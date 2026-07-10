import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { closeSync, linkSync, openSync, readFileSync, renameSync, rmSync, statSync, writeSync } from 'node:fs';
import { appendBytesDurable, appendJsonlDurable } from '@nullius/shared';
import { nulliusControlDir } from './state-manager.js';
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
  /** Project-relative POSIX path of the ledger file (absolute when the
   *  control-dir override points outside the project root). */
  path: string;
  exists: boolean;
  records: DecisionRecord[];
  /** Lines that failed to parse, lacked required fields, or repeated an id
   *  already seen (a duplicate id would make resolution ambiguous, so later
   *  duplicates are quarantined here instead of entering the read model). */
  invalid_lines: number;
};

const DECISION_ID_PATTERN = /^D(\d+)$/;

// Bounded wait for the cross-process append lock: 100 x 25ms = 2.5s covers
// any realistic holder (one read + one appended line), then fail loudly.
const LOCK_RETRY_ATTEMPTS = 100;
const LOCK_RETRY_SLEEP_MS = 25;
// A live holder finishes in well under a second; any lock older than this is
// stale no matter what its pid says (kills the zombie-lock failure mode where
// a stolen-and-restored lock names a long-lived process as holder).
const LOCK_HARD_MAX_AGE_MS = 60_000;
// Unreadable/empty locks (crash between create and pid write) reclaim much
// sooner: a live acquirer writes its content within milliseconds.
const LOCK_EMPTY_MAX_AGE_MS = 5_000;

export function decisionsLedgerPath(projectRoot: string): string {
  return path.join(nulliusControlDir(projectRoot), 'decisions.jsonl');
}

export function decisionsLedgerDisplayPath(projectRoot: string): string {
  const absolute = decisionsLedgerPath(projectRoot);
  const relative = path.relative(projectRoot, absolute);
  if (relative.startsWith('..') || path.isAbsolute(relative)) return absolute;
  return relative.split(path.sep).join('/');
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
  const displayPath = decisionsLedgerDisplayPath(projectRoot);
  if (!fs.existsSync(filePath)) {
    return { path: displayPath, exists: false, records: [], invalid_lines: 0 };
  }
  const records: DecisionRecord[] = [];
  const seenIds = new Set<string>();
  let invalidLines = 0;
  const lines = fs.readFileSync(filePath, 'utf-8').split(/\r?\n/);
  for (const line of lines) {
    if (line.trim().length === 0) continue;
    const record = parseDecisionLine(line);
    if (!record || seenIds.has(record.id)) {
      // A repeated id (hand edit, or the residual lock race documented in
      // withDecisionsLock) would make `--resolves <id>` ambiguous; the first
      // occurrence stays authoritative, later ones are quarantined and
      // surfaced through invalid_lines.
      invalidLines += 1;
      continue;
    }
    seenIds.add(record.id);
    records.push(record);
  }
  return { path: displayPath, exists: true, records, invalid_lines: invalidLines };
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
  if (highest >= Number.MAX_SAFE_INTEGER) {
    // Unreachable by honest sequential use; a hand-added ceiling id would
    // otherwise make the successor unparseable (rejected on reread) while the
    // command keeps reporting success with the same invisible id.
    throw new Error(`decision id space exhausted (D${highest} is the largest safe id); repair the ledger ids before recording`);
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

type LockInspection = {
  raw: string | null;
  stale: boolean;
};

function inspectLock(lockPath: string): LockInspection {
  let raw: string | null = null;
  let holderPid: number | null = null;
  try {
    raw = readFileSync(lockPath, 'utf-8');
    const content = JSON.parse(raw) as Record<string, unknown>;
    if (typeof content.pid === 'number' && Number.isInteger(content.pid) && content.pid > 0) {
      holderPid = content.pid;
    }
  } catch {
    holderPid = null;
  }
  let ageMs = 0;
  try {
    ageMs = Date.now() - statSync(lockPath).mtimeMs;
  } catch {
    return { raw, stale: false }; // vanished: nothing to reclaim, just retry
  }
  if (ageMs > LOCK_HARD_MAX_AGE_MS) return { raw, stale: true };
  if (holderPid !== null) return { raw, stale: !holderAlive(holderPid) };
  return { raw, stale: ageMs > LOCK_EMPTY_MAX_AGE_MS };
}

/** Single-winner reclamation of a stale lock.
 *
 *  Judging staleness and removing the file are not one atomic step, so a
 *  naive unlink can delete a FRESH lock created between the two. Instead the
 *  reclaimer renames the lock to a per-process claim path (rename is atomic;
 *  exactly one contender wins a given inode), then verifies the claimed bytes
 *  are the ones it judged stale. On mismatch it stole a live lock and puts it
 *  back via link(2) (which never replaces an existing path, so a
 *  concurrently-created new lock is never clobbered).
 *
 *  Residual window: if the live holder releases (unlink no-ops on the moved
 *  path) or a third process acquires during the microseconds between rename
 *  and restore, two holders can briefly coexist. That worst case produces a
 *  duplicate decision id, which the reader quarantines as an invalid line
 *  (see readDecisionsLedger) — detected and non-corrupting, the same bound
 *  the widely-used lockfile packages accept. The 60s hard age cap above keeps
 *  any restored-but-orphaned lock from outliving its usefulness.
 */
function reclaimStaleLock(lockPath: string, examined: LockInspection): void {
  const claimPath = `${lockPath}.reclaim.${process.pid}`;
  try {
    renameSync(lockPath, claimPath);
  } catch {
    return; // someone else won the reclaim (or the holder released): retry
  }
  let claimedRaw: string | null = null;
  try {
    claimedRaw = readFileSync(claimPath, 'utf-8');
  } catch {
    claimedRaw = null;
  }
  if (claimedRaw === examined.raw) {
    rmSync(claimPath, { force: true });
    return;
  }
  // We moved a lock that is not the one we judged stale — a fresh holder
  // acquired between inspection and rename. Restore it without clobbering
  // any newer lock: link() fails with EEXIST instead of replacing.
  try {
    linkSync(claimPath, lockPath);
  } catch {
    // lockPath is occupied again or the claim vanished; nothing safe to do —
    // the hard age cap and duplicate-id quarantine bound the damage.
  }
  rmSync(claimPath, { force: true });
}

function sleepBlocking(ms: number): void {
  const shared = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(shared), 0, 0, ms);
}

/** Cross-process mutual exclusion around read-allocate-append, so two CLI
 *  processes recording concurrently cannot allocate the same D<n>. The lock
 *  file carries the holder identity (control metadata, not durable project
 *  data — hence plain writes, mirroring the engine-store file lock). */
function withDecisionsLock<T>(projectRoot: string, action: () => T): T {
  const lockPath = lockFilePath(projectRoot);
  const myToken = JSON.stringify({ pid: process.pid, ts: utcNowIso(), nonce: randomUUID() });
  let acquired = false;
  for (let attempt = 0; attempt < LOCK_RETRY_ATTEMPTS; attempt += 1) {
    try {
      const fd = openSync(lockPath, 'wx');
      try {
        writeSync(fd, myToken);
      } finally {
        closeSync(fd);
      }
      acquired = true;
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const examined = inspectLock(lockPath);
      if (examined.stale) {
        reclaimStaleLock(lockPath, examined);
        continue;
      }
      sleepBlocking(LOCK_RETRY_SLEEP_MS);
    }
  }
  if (!acquired) {
    throw new Error(`decisions ledger is locked by another process (${lockPath}); retry in a moment`);
  }
  try {
    return action();
  } finally {
    // Ownership-checked release: remove the lock only when it still carries
    // our token, so a reclaimed-and-reissued lock is never deleted by the
    // previous holder.
    try {
      if (readFileSync(lockPath, 'utf-8') === myToken) {
        rmSync(lockPath, { force: true });
      }
    } catch {
      // already gone (reclaimed): nothing to release
    }
  }
}

/** A hand edit or an interrupted foreign write can leave the last line
 *  without a trailing newline; blindly appending would concatenate the new
 *  record onto it, corrupting BOTH lines. Repair by durably appending one LF
 *  in place — the inode, ownership, and mode are preserved, and a read-only
 *  ledger fails with a normal permission error instead of being replaced. */
function repairUnterminatedTail(filePath: string): void {
  if (!fs.existsSync(filePath)) return;
  const bytes = fs.readFileSync(filePath);
  if (bytes.length === 0) return;
  if (bytes[bytes.length - 1] === 0x0a) return;
  appendBytesDurable(filePath, '\n');
}

export function appendDecision(
  projectRoot: string,
  params: { kind: DecisionKind; text: string; by?: string | null; resolves?: string | null },
): DecisionRecord {
  const trimmed = params.text.trim();
  if (trimmed.length === 0) {
    throw new Error('decision text must not be empty');
  }
  // Recording requires an initialized project, and "initialized" means the
  // engine state exists — a bare control directory is not enough.
  if (!fs.existsSync(path.join(nulliusControlDir(projectRoot), 'state.json'))) {
    throw new Error('project is not initialized (missing state.json in the control dir); run nullius init first');
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
