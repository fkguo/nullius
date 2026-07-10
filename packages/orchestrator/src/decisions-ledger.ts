import { readFileSync, rmSync } from 'node:fs';
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

/** True when the value contains at least one substantive character.
 *  String.prototype.trim and Unicode White_Space DISAGREE at the edges:
 *  trim misses U+0085 NEXT LINE, and White_Space excludes U+FEFF (which trim
 *  removes) — either mismatch alone lets a visually empty value through one
 *  layer and vanish at the other. Validation and normalization both use the
 *  union. */
const NON_SUBSTANTIVE_CLASS = /[\p{White_Space}\uFEFF]/u;
function hasSubstantiveText(value: string): boolean {
  return !new RegExp(`^${NON_SUBSTANTIVE_CLASS.source}*$`, 'u').test(value);
}

/** Trims the same character class the substantive-text predicate ignores. */
function unicodeTrim(value: string): string {
  return value.replace(new RegExp(`^${NON_SUBSTANTIVE_CLASS.source}+|${NON_SUBSTANTIVE_CLASS.source}+$`, 'gu'), '');
}
// UTC-Z RFC3339, the only shape the recording path (utcNowIso) ever writes.
const UTC_ISO_TS_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

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
  /** Every canonical id the line's bytes visibly carry — parsed or salvaged —
   *  all reserved regardless of record admission, so no id that exists in
   *  the file in any form is ever reissued. */
  ids: string[];
  record: DecisionRecord | null;
};

const JSON_WHITESPACE = new Set([' ', '\t', '\r', '\n']);

type TopLevelScan = {
  /** Canonical id values from every VALID-PREFIX top-level `id` key. */
  ids: string[];
  /** Occurrence count per top-level key (duplicates preserved, however the
   *  key was escaped) within the valid prefix. */
  keyCounts: Map<string, number>;
  /** True only when the whole line is one syntactically well-formed object
   *  with nothing but whitespace after the closing brace. */
  complete: boolean;
};

/** JSON-aware scan of ONE line's top-level object fields. A regex cannot do
 *  this honestly, and neither can JSON.parse alone: escapes let a key spell
 *  itself as `"id"` and a value as `"D2"`, JSON.parse erases
 *  duplicate keys (last member wins — which would let conflicting `by`,
 *  `kind`, `text`, or `resolves` members smuggle past field validation), and
 *  a nested `{"meta":{"id":...}}` is not a record identity at all.
 *
 *  The scanner walks the top level of the object, decodes every key and
 *  string value through JSON.parse of the exact quoted token, validates
 *  scalar tokens the same way (so `bogus` is malformed, not silently
 *  skipped), skips nested structures with a full brace/bracket stack and
 *  string awareness, and STOPS at the first malformed position. Ids are
 *  therefore reserved from the valid PREFIX only: a crash tail keeps every
 *  candidate before the truncation, while garbage occurring before an id
 *  cannot smuggle a poisoned (e.g. ceiling) id into the reservation set. */
function scanTopLevelFields(line: string): TopLevelScan {
  const scan: TopLevelScan = { ids: [], keyCounts: new Map(), complete: false };
  const seenScanIds = new Set<string>();
  let i = 0;
  const n = line.length;
  const skipWs = () => { while (i < n && JSON_WHITESPACE.has(line[i]!)) i += 1; };
  // Consumes a JSON string starting at line[i] === '"'; returns the decoded
  // value, or null when unterminated/undecodable (scan then stops).
  const readString = (): string | null => {
    const start = i;
    i += 1;
    while (i < n) {
      const c = line[i]!;
      if (c === '\\') { i += 2; continue; }
      if (c === '"') {
        i += 1;
        try {
          return JSON.parse(line.slice(start, i)) as string;
        } catch {
          return null;
        }
      }
      i += 1;
    }
    return null;
  };
  // Consumes one top-level value. Returns the decoded string for string
  // values, undefined for valid non-string values, null on any malformation.
  const readValue = (): string | null | undefined => {
    skipWs();
    if (i >= n) return null;
    const c = line[i]!;
    if (c === '"') return readString();
    if (c === '{' || c === '[') {
      // Full container stack: `[{]` -style mismatches are malformed, not
      // silently balanced.
      const containerStart = i;
      const stack: string[] = [];
      while (i < n) {
        const d = line[i]!;
        if (d === '"') {
          if (readString() === null) return null;
          continue;
        }
        if (d === '{' || d === '[') {
          stack.push(d);
          i += 1;
          continue;
        }
        if (d === '}' || d === ']') {
          const open = stack.pop();
          if ((d === '}' && open !== '{') || (d === ']' && open !== '[')) return null;
          i += 1;
          if (stack.length === 0) {
            // Balanced is not enough: the container's CONTENTS must be valid
            // JSON too, or `{"junk":{"x":bogus},"id":"D<ceiling>"}` would
            // count as a valid prefix and reserve a poisoned id.
            try {
              JSON.parse(line.slice(containerStart, i));
              return undefined;
            } catch {
              return null;
            }
          }
          continue;
        }
        i += 1;
      }
      return null;
    }
    // Scalar token (number / true / false / null): must itself be valid JSON.
    const start = i;
    while (i < n && line[i] !== ',' && line[i] !== '}' && !JSON_WHITESPACE.has(line[i]!)) i += 1;
    const token = line.slice(start, i);
    if (token.length === 0) return null;
    try {
      JSON.parse(token);
      return undefined;
    } catch {
      return null;
    }
  };
  skipWs();
  if (line[i] !== '{') return scan;
  i += 1;
  for (;;) {
    skipWs();
    if (i >= n) return scan;
    if (line[i] === '}') {
      i += 1;
      skipWs();
      scan.complete = i >= n;
      return scan;
    }
    if (line[i] !== '"') return scan;
    const key = readString();
    if (key === null) return scan;
    skipWs();
    if (line[i] !== ':') return scan;
    i += 1;
    const value = readValue();
    if (value === null) return scan;
    scan.keyCounts.set(key, (scan.keyCounts.get(key) ?? 0) + 1);
    if (key === 'id' && typeof value === 'string' && decisionSequenceNumber(value) !== null && !seenScanIds.has(value)) {
      seenScanIds.add(value);
      scan.ids.push(value);
    }
    skipWs();
    if (line[i] === ',') { i += 1; continue; }
    if (line[i] === '}') continue;
    return scan;
  }
}

const LOAD_BEARING_KEYS = ['id', 'ts', 'kind', 'text', 'by', 'resolves'] as const;

function parseDecisionLine(line: string): ParsedDecisionLine {
  const scan = scanTopLevelFields(line);
  const ids = scan.ids;
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return { ids, record: null };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return { ids, record: null };
  // JSON.parse keeps only the LAST of duplicate members, so a repeated
  // load-bearing key (however escaped) could smuggle a conflicting id, kind,
  // text, authorship, or resolution past field validation. Admission requires
  // the scanner to have walked the whole line and seen each of these keys at
  // most once.
  if (!scan.complete) return { ids, record: null };
  if (LOAD_BEARING_KEYS.some(key => (scan.keyCounts.get(key) ?? 0) > 1)) return { ids, record: null };
  const record = parsed as Record<string, unknown>;
  const id = decisionSequenceNumber(record.id) !== null ? record.id as string : null;
  if (id === null) return { ids, record: null };
  // The recording path always writes a UTC-Z RFC3339 timestamp; a persisted
  // ts that is not one is a malformed line, not a value to display as-is.
  // Date.parse NORMALIZES overflowing components (2026-02-29 -> Mar 1,
  // 24:00 -> next day), so the parsed instant must round-trip to the same
  // second-level components.
  if (typeof record.ts !== 'string' || !UTC_ISO_TS_PATTERN.test(record.ts)) return { ids, record: null };
  const parsedInstant = new Date(record.ts);
  if (Number.isNaN(parsedInstant.getTime()) || parsedInstant.toISOString().slice(0, 19) !== record.ts.slice(0, 19)) {
    return { ids, record: null };
  }
  if (record.kind !== 'decided' && record.kind !== 'pending') return { ids, record: null };
  // Whitespace-only text is rejected at recording time; a persisted record
  // carrying it is malformed, not an admissible empty-looking decision.
  if (typeof record.text !== 'string' || !hasSubstantiveText(record.text)) return { ids, record: null };
  // Persisted authorship must be an explicit nonempty string: rewriting a
  // malformed `by` as "user" would invent provenance in a ledger whose whole
  // point is preserving who decided. (The CLI-side default to "user" applies
  // at RECORDING time, before persistence.)
  if (typeof record.by !== 'string' || !hasSubstantiveText(record.by)) return { ids, record: null };
  // Strict resolves validation: absent/null, or a canonical id on a decided
  // record. A malformed value or a pending record carrying resolves is a
  // malformed line, not something to silently coerce to null.
  let resolves: string | null = null;
  if (record.resolves !== undefined && record.resolves !== null) {
    if (record.kind !== 'decided') return { ids, record: null };
    if (decisionSequenceNumber(record.resolves) === null) return { ids, record: null };
    resolves = record.resolves as string;
  }
  return {
    ids,
    record: {
      id,
      ts: record.ts,
      kind: record.kind,
      text: record.text,
      by: record.by,
      resolves,
    },
  };
}

// Fatal per-line UTF-8 decoding: the default lossy decode would replace
// invalid bytes with U+FFFD and silently ADMIT a mutated decision text.
// A line that does not decode is quarantined; ids are still salvaged from
// its ASCII-compatible bytes so they stay reserved.
const FATAL_UTF8_DECODER = new TextDecoder('utf-8', { fatal: true });

/** Decodes the maximal valid UTF-8 PREFIX of the bytes: everything before
 *  the first invalid or incomplete sequence. Ids are then salvaged from that
 *  prefix only — bytes after an encoding error are unreadable garbage and
 *  must not smuggle reservations (e.g. a poisoned ceiling id) into
 *  allocation, mirroring the valid-prefix rule of the field scanner. */
/** Single-pass UTF-8 validation (RFC 3629: continuation shapes, overlongs,
 *  surrogates, and the U+10FFFF ceiling) returning the byte length of the
 *  maximal valid prefix. One pass plus one decode keeps a corrupt
 *  multi-megabyte line from stalling every status/list/record read the way a
 *  per-byte streaming decode would. */
function utf8ValidPrefixLength(bytes: Buffer): number {
  let i = 0;
  const n = bytes.length;
  while (i < n) {
    const b0 = bytes[i]!;
    if (b0 < 0x80) { i += 1; continue; }
    let need: number;
    let codePoint: number;
    let min: number;
    if (b0 >= 0xc2 && b0 <= 0xdf) { need = 1; codePoint = b0 & 0x1f; min = 0x80; }
    else if (b0 >= 0xe0 && b0 <= 0xef) { need = 2; codePoint = b0 & 0x0f; min = 0x800; }
    else if (b0 >= 0xf0 && b0 <= 0xf4) { need = 3; codePoint = b0 & 0x07; min = 0x10000; }
    else return i; // 0x80-0xc1 (bare continuation / overlong lead) and 0xf5+ are invalid
    if (i + need >= n) return i; // incomplete trailing sequence: dropped
    for (let k = 1; k <= need; k += 1) {
      const bk = bytes[i + k]!;
      if ((bk & 0xc0) !== 0x80) return i;
      codePoint = (codePoint << 6) | (bk & 0x3f);
    }
    if (codePoint < min) return i; // overlong encoding
    if (codePoint >= 0xd800 && codePoint <= 0xdfff) return i; // surrogate
    if (codePoint > 0x10ffff) return i;
    i += need + 1;
  }
  return n;
}

function maximalUtf8Prefix(bytes: Buffer): string {
  return FATAL_UTF8_DECODER.decode(bytes.subarray(0, utf8ValidPrefixLength(bytes)));
}

function decodeLedgerLine(bytes: Buffer): { text: string | null; validPrefix: string } {
  try {
    return { text: FATAL_UTF8_DECODER.decode(bytes), validPrefix: '' };
  } catch {
    return { text: null, validPrefix: maximalUtf8Prefix(bytes) };
  }
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
  // Byte-level split; each line is decoded with fatal UTF-8 so invalid bytes
  // quarantine the line instead of being silently replaced with U+FFFD.
  const rawLines = fs.readFileSync(filePath).toString('binary').split('\n');
  for (const rawLine of rawLines) {
    const lineBytes = Buffer.from(rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine, 'binary');
    // Blank detection on ASCII whitespace bytes ONLY: a lossy .trim() would
    // also swallow bytes like 0xA0 (latin1 NBSP) and skip a line that fatal
    // decoding must quarantine instead.
    if (lineBytes.every(byte => byte === 0x20 || byte === 0x09 || byte === 0x0d)) continue;
    const decoded = decodeLedgerLine(lineBytes);
    const { ids, record } = decoded.text !== null
      ? parseDecisionLine(decoded.text)
      : { ids: scanTopLevelFields(decoded.validPrefix).ids, record: null };
    // Reserve every id the line's bytes carry and advance the high-water
    // mark — quarantined or not — so allocation never reuses an id that
    // exists in the file in any form.
    const alreadyReserved = record !== null && reservedIds.has(record.id);
    for (const id of ids) {
      reservedIds.add(id);
      const sequence = decisionSequenceNumber(id);
      if (sequence !== null && sequence > highestSequence) highestSequence = sequence;
    }
    if (!record || alreadyReserved) {
      // Undecodable or malformed line, ambiguous identity, or a repeated id
      // (which would make `--resolves <id>` ambiguous): the first occurrence
      // stays authoritative, later ones are quarantined.
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

/** POSIX single-quote escaping so recovery guidance stays copy-pasteable
 *  (and non-executing) for roots containing spaces or shell metacharacters. */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
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
    let fd: number | null = null;
    try {
      fd = fs.openSync(lockPath, 'wx');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      sleepBlocking(LOCK_RETRY_SLEEP_MS);
      continue;
    }
    try {
      // We own the freshly created lock from here on: any failure writing or
      // closing its metadata must not orphan it.
      try {
        fs.writeSync(fd, JSON.stringify({ pid: process.pid, ts: utcNowIso() }));
      } finally {
        fs.closeSync(fd);
      }
    } catch (error) {
      rmSync(lockPath, { force: true });
      throw error;
    }
    acquired = true;
    break;
  }
  if (!acquired) {
    throw new Error(
      `decisions ledger is locked (${lockPath}; ${describeLockHolder(lockPath)}). `
      + 'If no recording process is running (e.g. after a crash), first check whether the '
      + `intended entry already landed (nullius decision list --project-root ${shellQuote(projectRoot)}) — `
      + 'a crashed holder may have completed its append — then remove that lock file and '
      + 'retry only if the entry is absent.',
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
  const trimmed = unicodeTrim(params.text);
  if (!hasSubstantiveText(trimmed)) {
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
      by: params.by && hasSubstantiveText(params.by) ? unicodeTrim(params.by) : 'user',
      resolves,
    };
    // Validation is done; only now touch the file (boundary repair + append),
    // so a rejected command never modifies the ledger bytes.
    repairUnterminatedTail(filePath);
    appendJsonlDurable(filePath, record);
    return record;
  });
}
