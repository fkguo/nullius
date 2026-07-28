import { randomFillSync } from 'node:crypto';
import { readFileSync, rmSync } from 'node:fs';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { appendBytesDurable } from '@nullius/shared';
import { nulliusControlDir } from './state-manager.js';
import { utcNowIso } from './util.js';

/** Append-only ledger of human decisions made in conversation.
 *
 *  Real projects resolve most questions conversationally ("use option 2",
 *  "confirmed, no change") and the outcome historically landed in hand-built
 *  markdown ledgers the engine never saw. This file is the engine-visible
 *  bookkeeping stratum of those decisions: one JSON line per event. The
 *  free-prose question documents stay project-owned; nothing here parses them.
 *
 *  Ids are MINTED, never counted. The ledger is version-controlled, so its
 *  history is a branching graph and not one sequence: two branches that each
 *  append a record are both writing "the next line" of their own copy of the
 *  file, and any id derived from a local scan (a highest-so-far counter) hands
 *  them the same name. After a merge the ledger then holds two different
 *  decisions called D38, and `--resolves D38` — the only way to close an open
 *  question — no longer names one entry. The id is therefore a ULID: a 48-bit
 *  millisecond timestamp followed by 80 random bits in Crockford base32,
 *  choosable without any coordination between branches or machines (see
 *  mintDecisionId for what that guarantee is and is not). Ids sort
 *  lexicographically by recording MILLISECOND, so a merged ledger still reads
 *  in chronological order down to that granularity; two ids minted inside one
 *  millisecond are unordered with respect to each other. Collisions already
 *  present in a ledger, and entries still numbered by the old counter, are
 *  reported by readDecisionsLedger rather than tolerated.
 *
 *  Recording never gates anything: open decisions surface in the status
 *  receipt as information, not as a blocking state. */

export type DecisionKind = 'decided' | 'pending';

export type DecisionRecord = {
  /** ULID minted at recording time; never reused, never derived from the
   *  file's contents. */
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

/** One id carried by more than one line of the ledger. */
export type DuplicateDecisionId = {
  id: string;
  /** 1-based physical line numbers carrying the id, in file order. */
  lines: number[];
};

/** One place a line still carries a number from the superseded counter. */
export type SupersededDecisionId = {
  id: string;
  /** 1-based physical line number. */
  line: number;
  /** Which field carries it. A superseded `id` needs the entry reissued; a
   *  superseded `resolves` needs repointing at the reissued entry — and it is
   *  reachable on its own, mid-migration, once the pending entries have been
   *  reissued but a decided entry still names the old number. */
  field: 'id' | 'resolves';
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
  /** Ids the file carries on more than one line, whatever their form. A ledger
   *  written by the superseded local counter can hold two entries named D38
   *  once two branches are merged, and nothing at merge time says so: the
   *  collision surfaces only when a human reads the log. Quarantining the
   *  later occurrence keeps the read model unambiguous but leaves the file
   *  wrong, so the collision is REPORTED — `decision list` fails on it, the
   *  status receipt carries it, and `--resolves` refuses the ambiguous id —
   *  until the duplicates are reissued by hand. Detection is deliberately
   *  form-agnostic: the ledgers that carry collisions are exactly the ones
   *  whose ids are not ULIDs. */
  duplicate_ids: DuplicateDecisionId[];
  /** Lines still numbered by the superseded counter. Those ids are no longer a
   *  form this ledger issues, so their lines are quarantined and their entries
   *  leave the read model entirely — including any question that was still
   *  open, which is the one thing the status receipt exists to keep in front of
   *  a human. Reported separately from `invalid_lines` because that count
   *  cannot say WHY a line was dropped, and this cause is both recognizable on
   *  sight and repairable: reissue each entry with a fresh id. Leaving it to a
   *  generic count would reproduce, on the migration path, exactly the silence
   *  that makes a merged collision dangerous. */
  superseded_ids: SupersededDecisionId[];
  /** Every id the file's bytes carry — including ids salvaged from
   *  quarantined lines — so a freshly minted id can be checked against them
   *  and no id that exists in the file in any form is ever issued again. */
  reserved_ids: string[];
};

// Crockford base32: I, L, O, and U are absent, so no character can be misread
// as another. Ids are matched case-sensitively against exactly this alphabet,
// which is what keeps the form canonical — Crockford DECODING is
// case-insensitive and folds I/L to 1 and O to 0, and every such spelling
// would otherwise be a second name for one entry, the way "D01" once aliased
// "D1".
const CROCKFORD_BASE32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
// 10 timestamp characters (a 48-bit millisecond count left-padded into 50
// bits, so the leading character is 0-7) followed by 16 random characters
// (80 bits).
const DECISION_ID_PATTERN = /^[0-7][0-9ABCDEFGHJKMNPQRSTVWXYZ]{25}$/;
const DECISION_ID_TIME_CHARS = 10;
const DECISION_ID_RANDOM_BYTES = 10;
// 9999-12-31T23:59:59.999Z: the last instant a record's `ts` can state in the
// four-digit-year form the reader accepts. Deliberately NOT the 2^48-1 the id
// itself could encode — see mintDecisionId.
const MAX_RECORDABLE_MS = Date.UTC(9999, 11, 31, 23, 59, 59, 999);
// EXACTLY the form the superseded local counter issued: "D" then a positive
// integer with no leading zero, inside the safe-integer range its allocation
// checked. Deliberately no broader — "D0", "D01", and a value past 2^53 are
// not ids that counter ever produced, so reporting them as superseded entries
// would prescribe a reissue for what is simply a malformed line, and would
// make `decision list` fail closed on a diagnosis that is not true. They stay
// in the generic invalid-line count with every other unrecognized id.
const SUPERSEDED_COUNTER_ID_PATTERN = /^D([1-9]\d*)$/;
// Redraws when a minted id already exists in the file. Reaching the bound is
// not a collision anyone will observe (80 random bits within one millisecond);
// it means the randomness source is returning a constant, which must fail
// loudly rather than mint a duplicate.
const DECISION_ID_MINT_ATTEMPTS = 8;

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
// UTC-Z RFC3339, the only shape the recording path (utcIsoAt) ever writes.
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

/** True for an id in exactly the minted form. Anything else — a lowercase
 *  spelling, a Crockford letter the alphabet excludes, a "D7" from the
 *  superseded counter — is not an id this ledger issues, so a line carrying
 *  one is malformed rather than a second identity to reason about. */
function isCanonicalDecisionId(id: unknown): id is string {
  return typeof id === 'string' && DECISION_ID_PATTERN.test(id);
}

/** True for a value the superseded counter could actually have issued. */
function isSupersededCounterId(value: string): boolean {
  const match = SUPERSEDED_COUNTER_ID_PATTERN.exec(value);
  return match !== null && Number.isSafeInteger(Number(match[1]));
}

/** Base32 of a millisecond count, high character first. Plain arithmetic, not
 *  bit operations: a 48-bit millisecond count is far past the 32-bit range
 *  where `<<` and `>>` silently wrap. */
function encodeDecisionIdTime(epochMs: number): string {
  let rest = epochMs;
  let encoded = '';
  for (let index = 0; index < DECISION_ID_TIME_CHARS; index += 1) {
    encoded = CROCKFORD_BASE32[rest % 32]! + encoded;
    rest = Math.floor(rest / 32);
  }
  return encoded;
}

/** 80 random bits as exactly 16 base32 characters. */
function encodeDecisionIdRandom(): string {
  const bytes = randomFillSync(new Uint8Array(DECISION_ID_RANDOM_BYTES));
  let pending = 0;
  let pendingBits = 0;
  let encoded = '';
  for (const byte of bytes) {
    // At most 4 bits are pending before each byte, so the accumulator stays
    // well inside the 32-bit range these operators are exact on.
    pending = (pending << 8) | byte;
    pendingBits += 8;
    while (pendingBits >= 5) {
      pendingBits -= 5;
      encoded += CROCKFORD_BASE32[(pending >> pendingBits) & 31]!;
    }
  }
  // 80 bits divide evenly by 5, so nothing is left pending.
  return encoded;
}

/** Mint one id for an entry recorded at `epochMs`.
 *
 *  The timestamp makes ids sort by recording time; the 80 random bits are what
 *  make a name safe to choose WITHOUT coordination, which is the whole point —
 *  two branches, or two machines, recording in the same millisecond share no
 *  state to coordinate through. Two independently minted ids are equal only if
 *  both the millisecond AND all 80 random bits coincide, which is a
 *  probabilistic guarantee, not an impossibility proof: this removes the
 *  collision that the previous local counter produced SYSTEMATICALLY (every
 *  pair of branches, every time) and leaves a residue no one will observe. The
 *  residue is not left unattended either — a ledger that does end up carrying
 *  one id twice is reported by readDecisionsLedger and refused by `--resolves`
 *  rather than silently resolved.
 *
 *  The ULID spec's monotonic variant (increment the previous id's random field
 *  within the same millisecond) is deliberately not used: deriving an id from
 *  the previous one is exactly the local-scan dependency that made branch
 *  copies collide, since two branches sharing an ancestor would increment the
 *  same id — turning the residue back into a systematic collision. Every id
 *  gets fresh randomness. */
function mintDecisionId(epochMs: number, reserved: ReadonlySet<string>): string {
  // The bound is the RECORD's, not the encoding's: 48 bits of milliseconds
  // reach the year 10889, but a `ts` past 9999 is written by toISOString in
  // the expanded-year form (+010000-01-01T00:00:00Z), which the reader's
  // four-digit-year pattern rejects. Minting anywhere in that gap would append
  // a record that the very next read quarantines while the command reports
  // success — the invisible-record failure this check exists to prevent.
  if (!Number.isSafeInteger(epochMs) || epochMs < 0 || epochMs > MAX_RECORDABLE_MS) {
    throw new Error(
      `the system clock reads ${epochMs} ms since the epoch, outside the range a decision entry can `
      + `record (0..${MAX_RECORDABLE_MS}, i.e. through 9999-12-31T23:59:59Z); fix the clock before recording`,
    );
  }
  const time = encodeDecisionIdTime(epochMs);
  for (let attempt = 0; attempt < DECISION_ID_MINT_ATTEMPTS; attempt += 1) {
    const candidate = `${time}${encodeDecisionIdRandom()}`;
    if (!reserved.has(candidate)) return candidate;
  }
  throw new Error(
    `could not mint a decision id distinct from the ${reserved.size} already in the ledger after `
    + `${DECISION_ID_MINT_ATTEMPTS} attempts; the random source is not returning random bytes`,
  );
}

/** Second-precision UTC-Z stamp of a specific instant, so a record's `ts` and
 *  the millisecond inside its id describe the same moment instead of two
 *  clock reads that can straddle a second boundary. */
function utcIsoAt(epochMs: number): string {
  return new Date(epochMs).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

type ParsedDecisionLine = {
  /** Every id the line's bytes visibly carry — parsed or salvaged, canonical
   *  or not — all reserved regardless of record admission, so no id that
   *  exists in the file in any form is ever reissued, and all counted for
   *  duplicate reporting. */
  ids: string[];
  /** Top-level `resolves` values the line carries — references, never
   *  identities: not reserved, not counted as id occurrences, collected only
   *  so one still naming a superseded number can be reported. */
  resolvesValues: string[];
  record: DecisionRecord | null;
};

const JSON_WHITESPACE = new Set([' ', '\t', '\r', '\n']);

type TopLevelScan = {
  /** String values of every VALID-PREFIX top-level `id` key, deduplicated
   *  within the line. Not filtered to the canonical form: a ledger written by
   *  the superseded counter carries "D38" ids, and those are precisely the
   *  ones whose duplicates must still be reported. */
  ids: string[];
  /** String values of every VALID-PREFIX top-level `resolves` key, deduplicated
   *  within the line. Kept apart from `ids`: a resolution target is a
   *  REFERENCE, not this line's identity, so it must never be reserved or
   *  counted as an occurrence of an id. Collected so a line still pointing at
   *  a superseded number can be named. */
  resolvesValues: string[];
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
  const scan: TopLevelScan = { ids: [], resolvesValues: [], keyCounts: new Map(), complete: false };
  const seenScanIds = new Set<string>();
  const seenScanResolves = new Set<string>();
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
    if (key === 'id' && typeof value === 'string' && !seenScanIds.has(value)) {
      seenScanIds.add(value);
      scan.ids.push(value);
    }
    if (key === 'resolves' && typeof value === 'string' && !seenScanResolves.has(value)) {
      seenScanResolves.add(value);
      scan.resolvesValues.push(value);
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
  const resolvesValues = scan.resolvesValues;
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return { ids, resolvesValues, record: null };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return { ids, resolvesValues, record: null };
  // JSON.parse keeps only the LAST of duplicate members, so a repeated
  // load-bearing key (however escaped) could smuggle a conflicting id, kind,
  // text, authorship, or resolution past field validation. Admission requires
  // the scanner to have walked the whole line and seen each of these keys at
  // most once.
  if (!scan.complete) return { ids, resolvesValues, record: null };
  if (LOAD_BEARING_KEYS.some(key => (scan.keyCounts.get(key) ?? 0) > 1)) return { ids, resolvesValues, record: null };
  const record = parsed as Record<string, unknown>;
  if (!isCanonicalDecisionId(record.id)) return { ids, resolvesValues, record: null };
  const id = record.id;
  // The recording path always writes a UTC-Z RFC3339 timestamp; a persisted
  // ts that is not one is a malformed line, not a value to display as-is.
  // Date.parse NORMALIZES overflowing components (2026-02-29 -> Mar 1,
  // 24:00 -> next day), so the parsed instant must round-trip to the same
  // second-level components.
  if (typeof record.ts !== 'string' || !UTC_ISO_TS_PATTERN.test(record.ts)) return { ids, resolvesValues, record: null };
  const parsedInstant = new Date(record.ts);
  if (Number.isNaN(parsedInstant.getTime()) || parsedInstant.toISOString().slice(0, 19) !== record.ts.slice(0, 19)) {
    return { ids, resolvesValues, record: null };
  }
  if (record.kind !== 'decided' && record.kind !== 'pending') return { ids, resolvesValues, record: null };
  // Whitespace-only text is rejected at recording time; a persisted record
  // carrying it is malformed, not an admissible empty-looking decision.
  if (typeof record.text !== 'string' || !hasSubstantiveText(record.text)) return { ids, resolvesValues, record: null };
  // Persisted authorship must be an explicit nonempty string: rewriting a
  // malformed `by` as "user" would invent provenance in a ledger whose whole
  // point is preserving who decided. (The CLI-side default to "user" applies
  // at RECORDING time, before persistence.)
  if (typeof record.by !== 'string' || !hasSubstantiveText(record.by)) return { ids, resolvesValues, record: null };
  // Strict resolves validation: absent/null, or a canonical id on a decided
  // record. A malformed value or a pending record carrying resolves is a
  // malformed line, not something to silently coerce to null.
  let resolves: string | null = null;
  if (record.resolves !== undefined && record.resolves !== null) {
    if (record.kind !== 'decided') return { ids, resolvesValues, record: null };
    if (!isCanonicalDecisionId(record.resolves)) return { ids, resolvesValues, record: null };
    resolves = record.resolves;
  }
  return {
    ids,
    resolvesValues,
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
    return {
      path: displayPath,
      exists: false,
      records: [],
      invalid_lines: 0,
      duplicate_ids: [],
      superseded_ids: [],
      reserved_ids: [],
    };
  }
  const records: DecisionRecord[] = [];
  /** Every id the file carries, mapped to the lines carrying it: the
   *  reservation set and the duplicate report are the same observation. */
  const idLines = new Map<string, number[]>();
  const supersededIds: SupersededDecisionId[] = [];
  const openIds = new Set<string>();
  let invalidLines = 0;
  // Byte-level split; each line is decoded with fatal UTF-8 so invalid bytes
  // quarantine the line instead of being silently replaced with U+FFFD.
  const rawLines = fs.readFileSync(filePath).toString('binary').split('\n');
  for (const [index, rawLine] of rawLines.entries()) {
    const lineNumber = index + 1;
    const lineBytes = Buffer.from(rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine, 'binary');
    // Blank detection on ASCII whitespace bytes ONLY: a lossy .trim() would
    // also swallow bytes like 0xA0 (latin1 NBSP) and skip a line that fatal
    // decoding must quarantine instead.
    if (lineBytes.every(byte => byte === 0x20 || byte === 0x09 || byte === 0x0d)) continue;
    const decoded = decodeLedgerLine(lineBytes);
    const { ids, resolvesValues, record } = decoded.text !== null
      ? parseDecisionLine(decoded.text)
      : { ...scanTopLevelFields(decoded.validPrefix), record: null };
    // Reserve every id the line's bytes carry — quarantined or not — so no id
    // that exists in the file in any form is ever minted again, and record
    // where it occurs so repeats are reportable.
    const alreadyReserved = record !== null && idLines.has(record.id);
    for (const id of ids) {
      const lines = idLines.get(id);
      if (lines) lines.push(lineNumber);
      else idLines.set(id, [lineNumber]);
      if (isSupersededCounterId(id)) supersededIds.push({ id, line: lineNumber, field: 'id' });
    }
    // A resolution target is a reference, not an identity: it is deliberately
    // NOT reserved and not counted as an occurrence. It is still reported when
    // it names a superseded number, because mid-migration — pending entries
    // already reissued, a decided entry still pointing at the old number — that
    // is the only place the stale number appears, and the line would otherwise
    // fall into the generic invalid-line count with nothing naming the cause.
    for (const value of resolvesValues) {
      if (isSupersededCounterId(value)) supersededIds.push({ id: value, line: lineNumber, field: 'resolves' });
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
      // reference would silently close a later, unrelated question as soon as
      // that question lands; a replayed reference re-closes nothing.
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
  const duplicateIds: DuplicateDecisionId[] = [];
  for (const [id, lines] of idLines) {
    if (lines.length > 1) duplicateIds.push({ id, lines });
  }
  return {
    path: displayPath,
    exists: true,
    records,
    invalid_lines: invalidLines,
    duplicate_ids: duplicateIds,
    superseded_ids: supersededIds,
    reserved_ids: [...idLines.keys()],
  };
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

/** Cross-process mutual exclusion around read-validate-append. Minted ids no
 *  longer depend on the file, so this is not what keeps them distinct; it
 *  keeps the two steps that DO read the file before writing it whole. Two
 *  concurrent recorders would otherwise be able to close the same open pending
 *  entry (each validating `--resolves` against a snapshot taken before the
 *  other's append), and a tail repair could land between another process's
 *  read and its append, concatenating two records into one corrupt line. The
 *  lock file carries the holder identity (control metadata, not durable
 *  project data — hence plain writes, mirroring the engine-store file lock).
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
      // Fail closed on an id the file carries twice. The read model keeps only
      // the first occurrence, so resolving would silently pick one of two
      // different questions — the exact ambiguity a merged counter-numbered
      // ledger produces.
      const duplicate = snapshot.duplicate_ids.find((entry) => entry.id === params.resolves);
      if (duplicate) {
        throw new Error(
          `--resolves ${params.resolves} is ambiguous: ${snapshot.path} carries that id on lines `
          + `${duplicate.lines.join(', ')}. Reissue every occurrence after the first with a fresh id `
          + '(and repoint any resolves naming it) before resolving it.',
        );
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
    const recordedAtMs = Date.now();
    const record: DecisionRecord = {
      id: mintDecisionId(recordedAtMs, new Set(snapshot.reserved_ids)),
      ts: utcIsoAt(recordedAtMs),
      kind: params.kind,
      text: trimmed,
      by: params.by && hasSubstantiveText(params.by) ? unicodeTrim(params.by) : 'user',
      resolves,
    };
    // Last check before any byte is written: the exact line about to be
    // appended must be one this module's OWN reader admits. A command that
    // reports success while writing an entry the next read quarantines is the
    // worst outcome available — the decision looks recorded and is not.
    //
    // Reachability, stated plainly rather than implied: with the clock bound
    // above in place, NO input reaches this branch. Every field is either a
    // literal union, minted canonical, or validated by the same predicate the
    // reader uses. It is kept as the structural half of the guarantee — if the
    // clock bound is ever loosened, or a new field is added whose recording
    // and parsing rules drift apart, this is what stops the invisible record —
    // and it is exercised by fault injection (decisions-id-mint-fault.test.ts)
    // rather than left as an assertion no test can distinguish from a no-op.
    const line = JSON.stringify(record);
    if (parseDecisionLine(line).record === null) {
      throw new Error(
        `refusing to append a decision entry this ledger's own reader would quarantine `
        + `(id ${record.id}, ts ${record.ts}); nothing was written`,
      );
    }
    // Validation is done; only now touch the file (boundary repair + append),
    // so a rejected command never modifies the ledger bytes. The checked line
    // is what gets appended, not a second serialization of the same object.
    repairUnterminatedTail(filePath);
    appendBytesDurable(filePath, `${line}\n`);
    return record;
  });
}
