import { closeSync, openSync, readFileSync, rmSync, writeSync } from 'node:fs';
import * as fs from 'node:fs';
import * as path from 'node:path';
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
  /** Lines quarantined instead of entering the read model: unparseable JSON,
   *  missing/unsafe fields, an id already seen (ambiguous resolution target),
   *  or a decided entry whose `resolves` does not reference an EARLIER, still
   *  OPEN pending entry (forward or replayed resolutions would silently close
   *  a later, unrelated question). */
  invalid_lines: number;
  /** Largest sequence number seen on ANY syntactically valid id — including
   *  quarantined lines — so allocation never reuses an id that exists as
   *  bytes in the file. */
  highest_id_sequence: number;
};

// Canonical ids only: no leading zeros, so "D01" can never alias "D1" as a
// second identity for the same numeric sequence.
const DECISION_ID_PATTERN = /^D([1-9]\d*)$/;

// Bounded wait for the cross-process append lock: 100 x 25ms = 2.5s covers
// any realistic holder (one read + one appended line), then fail loudly.
// There is deliberately NO automatic stale-lock reclamation: every
// judge-then-remove protocol on plain filesystem primitives has a window in
// which it can delete a fresh holder's lock (judgement and removal are not
// one atomic step). A lock left behind by a crash is repaired explicitly and
// quiescently by the operator — the failure error names the exact file.
const LOCK_RETRY_ATTEMPTS = 100;
const LOCK_RETRY_SLEEP_MS = 25;

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

type ParsedDecisionLine = {
  /** Canonical id found on the line, even when the record itself is
   *  quarantined — its sequence number is reserved either way. */
  id: string | null;
  record: DecisionRecord | null;
};

// Salvages a canonical id from a line whose JSON is broken (e.g. the crash
// tail `{"id":"D1","ts":`), so even a malformed line reserves the id it
// visibly carries and allocation never reissues it.
const RAW_ID_SALVAGE_PATTERN = /"id"\s*:\s*"(D[1-9]\d*)"/;

function parseDecisionLine(line: string): ParsedDecisionLine {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    const salvaged = RAW_ID_SALVAGE_PATTERN.exec(line);
    return { id: salvaged ? salvaged[1] ?? null : null, record: null };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return { id: null, record: null };
  const record = parsed as Record<string, unknown>;
  // Extract the id FIRST: a line that carries a canonical id reserves its
  // sequence number no matter what else is wrong with it, so quarantining a
  // line never frees its id for reuse.
  const id = decisionSequenceNumber(record.id) !== null ? record.id as string : null;
  if (id === null) return { id: null, record: null };
  if (typeof record.ts !== 'string') return { id, record: null };
  if (record.kind !== 'decided' && record.kind !== 'pending') return { id, record: null };
  if (typeof record.text !== 'string' || record.text.length === 0) return { id, record: null };
  // Strict resolves validation: absent/null, or a canonical id on a decided
  // record. A malformed value or a pending record carrying resolves is a
  // malformed line, not something to silently coerce to null.
  let resolves: string | null = null;
  if (record.resolves !== undefined && record.resolves !== null) {
    if (record.kind !== 'decided') return { id, record: null };
    if (decisionSequenceNumber(record.resolves) === null) return { id, record: null };
    resolves = record.resolves as string;
  }
  return {
    id,
    record: {
      id,
      ts: record.ts,
      kind: record.kind,
      text: record.text,
      by: typeof record.by === 'string' && record.by.length > 0 ? record.by : 'user',
      resolves,
    },
  };
}

export function readDecisionsLedger(projectRoot: string): DecisionsLedgerSnapshot {
  const filePath = decisionsLedgerPath(projectRoot);
  const displayPath = decisionsLedgerDisplayPath(projectRoot);
  if (!fs.existsSync(filePath)) {
    return { path: displayPath, exists: false, records: [], invalid_lines: 0, highest_id_sequence: 0 };
  }
  const records: DecisionRecord[] = [];
  const reservedIds = new Set<string>();
  const openIds = new Set<string>();
  let invalidLines = 0;
  let highestSequence = 0;
  const lines = fs.readFileSync(filePath, 'utf-8').split(/\r?\n/);
  for (const line of lines) {
    if (line.trim().length === 0) continue;
    const { id, record } = parseDecisionLine(line);
    // Reserve the id and advance the high-water mark for EVERY line that
    // carries a canonical id — quarantined or not — so allocation never
    // reuses an id that exists as bytes in the file.
    const alreadyReserved = id !== null && reservedIds.has(id);
    if (id !== null) {
      reservedIds.add(id);
      const sequence = decisionSequenceNumber(id);
      if (sequence !== null && sequence > highestSequence) highestSequence = sequence;
    }
    if (!record || alreadyReserved) {
      // Malformed line, or a repeated id (which would make `--resolves <id>`
      // ambiguous): the first occurrence stays authoritative, later ones are
      // quarantined.
      invalidLines += 1;
      continue;
    }
    if (record.kind === 'decided' && record.resolves !== null && !openIds.has(record.resolves)) {
      // Sequential semantics: a resolution must reference an EARLIER pending
      // entry that is still open at this point in the file. A forward
      // reference would silently close a later, unrelated question the
      // moment its id is allocated; a replayed reference re-closes nothing.
      invalidLines += 1;
      continue;
    }
    if (record.kind === 'pending') {
      openIds.add(record.id);
    } else if (record.resolves !== null) {
      openIds.delete(record.resolves);
    }
    records.push(record);
  }
  return { path: displayPath, exists: true, records, invalid_lines: invalidLines, highest_id_sequence: highestSequence };
}

/** Pending entries not closed by any later decided entry. Oldest first.
 *  (readDecisionsLedger quarantines forward/replayed resolutions, so on a
 *  snapshot's records the global set below equals sequential processing.) */
export function openDecisions(records: DecisionRecord[]): DecisionRecord[] {
  const resolved = new Set(
    records
      .filter((record) => record.kind === 'decided' && record.resolves !== null)
      .map((record) => record.resolves as string),
  );
  return records.filter((record) => record.kind === 'pending' && !resolved.has(record.id));
}

function nextDecisionId(snapshot: DecisionsLedgerSnapshot): string {
  const highest = snapshot.highest_id_sequence;
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

function sleepBlocking(ms: number): void {
  const shared = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(shared), 0, 0, ms);
}

function describeLockHolder(lockPath: string): string {
  try {
    const content = JSON.parse(readFileSync(lockPath, 'utf-8')) as Record<string, unknown>;
    if (typeof content.pid === 'number') return `held by pid ${content.pid} since ${String(content.ts ?? 'unknown time')}`;
  } catch {
    // fall through
  }
  return 'holder unknown';
}

/** Cross-process mutual exclusion around read-allocate-append, so two CLI
 *  processes recording concurrently cannot allocate the same D<n>. The lock
 *  file carries the holder identity (control metadata, not durable project
 *  data — hence plain writes, mirroring the engine-store file lock).
 *
 *  Fail-closed on a lock that outlives the bounded wait: the error names the
 *  file and the quiescent repair (verify no recorder is running, remove the
 *  file, retry). No automatic reclamation — see the note on the constants. */
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
      sleepBlocking(LOCK_RETRY_SLEEP_MS);
    }
  }
  if (!acquired) {
    throw new Error(
      `decisions ledger is locked (${lockPath}; ${describeLockHolder(lockPath)}). `
      + 'If no recording process is running (e.g. after a crash), first check whether the '
      + 'intended entry already landed (nullius decision list) — a crashed holder may have '
      + 'completed its append — then remove that lock file and retry only if the entry is absent.',
    );
  }
  try {
    return action();
  } finally {
    rmSync(lockPath, { force: true });
  }
}

/** A hand edit or an interrupted foreign write can leave the last line
 *  without a trailing newline; blindly appending would concatenate the new
 *  record onto it, corrupting BOTH lines. Repair by durably appending one LF
 *  in place — the inode, ownership, and mode are preserved, and a read-only
 *  ledger fails with a normal permission error instead of being replaced.
 *  (Parsing does not need the repair — split('\n') reads an unterminated
 *  final line fine — so validation runs first and this runs only when a
 *  record is actually about to be appended.) */
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
      id: nextDecisionId(snapshot),
      ts: utcNowIso(),
      kind: params.kind,
      text: trimmed,
      by: params.by && params.by.trim().length > 0 ? params.by.trim() : 'user',
      resolves,
    };
    // Validation is done; only now touch the file (boundary repair + append),
    // so a rejected command never modifies the ledger bytes.
    repairUnterminatedTail(filePath);
    appendJsonlDurable(filePath, record);
    return record;
  });
}
