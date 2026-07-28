import { randomFillSync } from 'node:crypto';
import { readFileSync, rmSync } from 'node:fs';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  appendBytesDurable,
  fsyncParentDirectoryDurable,
  writeBytesAtomicDurable,
} from '@nullius/shared';
import { nulliusControlDir } from './state-manager.js';
import { utcNowIso } from './util.js';

/** Ledger of human decisions made in conversation.
 *
 *  Real projects resolve most questions conversationally ("use option 2",
 *  "confirmed, no change") and the outcome historically landed in hand-built
 *  markdown ledgers the engine never saw. This file is the engine-visible
 *  bookkeeping stratum of those decisions: one JSON line per event. The
 *  free-prose question documents stay project-owned; nothing here parses them.
 *
 *  Identity has two phases because its requirements do too. Before merge, an
 *  entry gets a six-character random Crockford-base32 HANDLE. It is short-lived
 *  coordination-free identity for branch-local relations, not a prose
 *  citation. After the branch tails have landed on the trunk, `decision land`
 *  atomically assigns the next durable D<n> numbers in trunk file order,
 *  rewrites handle-valued relations, and retains each handle in the landed
 *  entry as `provisional_id`. Existing all-D<n> ledgers are already durable:
 *  they need no migration, and their cited ids remain valid.
 *
 *  The two namespaces make the unavoidable trade-off explicit: handles can be
 *  chosen independently on branches, while durable ids stay short, monotone,
 *  and permanent once cited. A merged ledger can still contain a handle
 *  collision (or an old D<n> collision), so duplicate detection remains
 *  form-agnostic and fail-closed rather than silently resolving one occurrence.
 *
 *  Recording is append-only; explicit trunk-side landing is the one
 *  canonicalizing rewrite. Open decisions do not gate the run/approve
 *  lifecycle: they surface in the status receipt as information, not as a
 *  blocking state. */

export type DecisionKind = 'decided' | 'pending';

export type DecisionRecord = {
  /** Durable D<n> after landing, otherwise a provisional branch handle. */
  id: string;
  /** The pre-landing identity retained on a durable record for traceability.
   *  Absent on existing D<n> records and on entries not yet landed. */
  provisional_id?: string;
  /** UTC ISO timestamp. */
  ts: string;
  /** Current operational kind. Persisted legacy/unknown string kinds are
   *  conservatively normalized to `decided`; their exact source spelling is
   *  retained here and reported separately by the snapshot. Only an exact
   *  persisted `pending` creates an open obligation. */
  kind: DecisionKind;
  source_kind?: string;
  /** What was decided (kind=decided) or what awaits a decision (kind=pending). */
  text: string;
  /** Who decided / who is being asked. Defaults to "user" at the CLI. */
  by: string;
  /** For kind=decided: id of the open pending entry this decision closes. */
  resolves: string | null;
  /** A non-closing reference to any earlier admitted decision entry. */
  relates: string | null;
};

/** One id carried by more than one line of the ledger. */
export type DuplicateDecisionId = {
  id: string;
  /** 1-based physical line numbers carrying the id, in file order. */
  lines: number[];
};

export type DecisionRelationName = 'resolves' | 'relates';

export type DecisionRelationIssueReason =
  | 'duplicate_field'
  | 'invalid_target'
  | 'not_allowed_for_kind'
  | 'ambiguous_target'
  | 'target_not_found'
  | 'target_not_prior'
  | 'target_unreadable'
  | 'target_not_pending'
  | 'target_already_resolved';

/** A relation that was ignored without discarding its containing record. */
export type DecisionRelationIssue = {
  /** 1-based physical ledger line. */
  line: number;
  /** Identity of the admitted record carrying the ignored relation. */
  id: string;
  relation: DecisionRelationName;
  /** Raw target when one unambiguous string was recoverable. */
  target: string | null;
  reason: DecisionRelationIssueReason;
};

/** Compatibility normalization applied only in the read model; persisted
 *  bytes remain unchanged. */
export type DecisionKindNormalization = {
  line: number;
  id: string;
  source_kind: string;
  kind: DecisionKind;
};

export type DecisionsLedgerSnapshot = {
  /** Project-relative POSIX path of the ledger file (absolute when the
   *  control-dir override points outside the project root). */
  path: string;
  exists: boolean;
  records: DecisionRecord[];
  /** Lines quarantined instead of entering the read model: unparseable JSON,
   *  missing/unsafe core fields, or an id already seen (ambiguous identity).
   *  Relation defects never increment this count: they are reported below and
   *  only the link is ignored. */
  invalid_lines: number;
  /** Malformed, ambiguous, forward, or semantically inapplicable links. The
   *  containing record remains counted/listed/addressable; the link alone has
   *  no effect on the open set. */
  unrecognized_relations: DecisionRelationIssue[];
  /** Legacy/unknown persisted kinds normalized into the current read model.
   *  Unknown strings map to current `decided` semantics; only exact
   *  `pending` creates an open item. */
  normalized_kinds: DecisionKindNormalization[];
  /** Ids the file carries on more than one line, whatever their form. The
   *  first occurrence remains visible but any relation naming the duplicated
   *  id is ignored, `decision list` exits non-zero, and new links refuse it
   *  until the ambiguity is repaired. */
  duplicate_ids: DuplicateDecisionId[];
  /** Provisional identities that are not one-to-one: retained on more than
   *  one durable entry, or retained on one entry while reused as another
   *  entry's current id. Any old branch relation naming one is ambiguous. */
  ambiguous_provisional_ids: DuplicateDecisionId[];
  /** Every id attributable to a line's valid prefix — including ids salvaged
   *  from quarantined lines — so a freshly minted handle can be checked against
   *  all current identities already visible in the ledger. */
  reserved_ids: string[];
  /** Every retained provisional identity attributable to a line's valid
   *  prefix. Locally minted handles avoid these too because a late branch may
   *  still name them before its next trunk-side landing. */
  reserved_provisional_ids: string[];
  /** Largest durable D<n> sequence found anywhere in a valid-prefix id field,
   *  including quarantined lines, so landing never reuses visible bytes. */
  highest_durable_sequence: number;
  /** Admitted entries that still carry provisional identity. */
  unlanded_ids: string[];
};

export type DecisionIdLanding = {
  provisional_id: string;
  id: string;
};

export type DecisionLandingResult = {
  path: string;
  landed: DecisionIdLanding[];
  /** Persisted handle-valued resolves fields rewritten through retained or
   *  newly-created mappings, including cleanup-only passes with no new ids. */
  rewritten_resolutions: number;
  /** Persisted handle-valued non-closing `relates` fields rewritten through
   *  retained or newly-created mappings. */
  rewritten_related_links: number;
};

// Crockford base32: I, L, O, and U are absent. Canonical spellings are
// uppercase and case-sensitive, so one handle cannot acquire aliases.
const CROCKFORD_BASE32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const DECISION_HANDLE_PATTERN = /^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{6}$/;
// Read compatibility for entries recorded during the brief ULID-only release.
// They are provisional identities too and `decision land` folds them to D<n>.
const RELEASE_ULID_PATTERN = /^[0-7][0-9ABCDEFGHJKMNPQRSTVWXYZ]{25}$/;
const DURABLE_DECISION_ID_PATTERN = /^D([1-9]\d*)$/;
const DECISION_HANDLE_RANDOM_BYTES = 4;
// 9999-12-31T23:59:59.999Z: the last instant a record's `ts` can state in the
// four-digit-year form the reader accepts.
const MAX_RECORDABLE_MS = Date.UTC(9999, 11, 31, 23, 59, 59, 999);
// Redraws when a minted handle already exists in the file. Eight redraws make
// accidental exhaustion negligible under a healthy random source; reaching
// the bound strongly indicates failed or compromised randomness and must fail
// loudly rather than mint a duplicate. Candidates that also spell D<n> are
// redrawn to keep provisional and durable namespaces disjoint.
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

/** Parse a durable id like D7 to its positive safe-integer sequence. */
function decisionSequenceNumber(id: unknown): number | null {
  if (typeof id !== 'string') return null;
  const match = DURABLE_DECISION_ID_PATTERN.exec(id);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

function isDurableDecisionId(id: unknown): id is string {
  return decisionSequenceNumber(id) !== null;
}

/** True for either current six-character handles or ULIDs emitted by the
 *  immediately preceding release. A handle that also spells D<n> is excluded
 *  so one string never belongs to both identity phases. */
function isProvisionalDecisionId(id: unknown): id is string {
  return typeof id === 'string'
    && (
      (DECISION_HANDLE_PATTERN.test(id) && !isDurableDecisionId(id))
      || RELEASE_ULID_PATTERN.test(id)
    );
}

function isCanonicalDecisionId(id: unknown): id is string {
  return isDurableDecisionId(id) || isProvisionalDecisionId(id);
}

/** Six Crockford characters from 30 unbiased random bits. */
function encodeDecisionHandle(): string {
  const bytes = randomFillSync(new Uint8Array(DECISION_HANDLE_RANDOM_BYTES));
  // Mask the two high surplus bits: 2^30 is exactly 32^6, so no modulo bias.
  let rest = (bytes[0]! & 0x3f) * 0x1000000
    + bytes[1]! * 0x10000
    + bytes[2]! * 0x100
    + bytes[3]!;
  let encoded = '';
  for (let index = 0; index < 6; index += 1) {
    encoded = CROCKFORD_BASE32[rest % 32]! + encoded;
    rest = Math.floor(rest / 32);
  }
  return encoded;
}

function assertRecordableEpochMs(epochMs: number): void {
  if (!Number.isSafeInteger(epochMs) || epochMs < 0 || epochMs > MAX_RECORDABLE_MS) {
    throw new Error(
      `the system clock reads ${epochMs} ms since the epoch, outside the range a decision entry can `
      + `record (0..${MAX_RECORDABLE_MS}, i.e. through 9999-12-31T23:59:59Z); fix the clock before recording`,
    );
  }
}

/** Mint a provisional branch handle without consulting global history. */
function mintDecisionHandle(reserved: ReadonlySet<string>): string {
  for (let attempt = 0; attempt < DECISION_ID_MINT_ATTEMPTS; attempt += 1) {
    const candidate = encodeDecisionHandle();
    if (!isDurableDecisionId(candidate) && !reserved.has(candidate)) return candidate;
  }
  throw new Error(
    `could not mint a provisional decision handle distinct from the ${reserved.size} ids already in the ledger after `
    + `${DECISION_ID_MINT_ATTEMPTS} attempts; the random source is not returning random bytes`,
  );
}

/** Millisecond-precision UTC-Z stamp from the same clock read as the record. */
function utcIsoAt(epochMs: number): string {
  return new Date(epochMs).toISOString();
}

type ParsedDecisionLine = {
  /** Every id the line's bytes visibly carry — parsed or salvaged, canonical
   *  or not — all attributable to the valid prefix and reserved regardless of
   *  record admission, so visible collisions are redrawn or refused and all
   *  occurrences are counted for duplicate reporting. */
  ids: string[];
  /** Top-level retained pre-landing identities. They remain operational as
   *  aliases for late branch relations until those relations are landed. */
  provisionalIds: string[];
  /** Top-level `resolves` values the line carries — references, never
   *  identities: not reserved and not counted as id occurrences. */
  resolvesValues: string[];
  /** Top-level non-closing relation values, likewise never identities. */
  relatesValues: string[];
  /** Structurally malformed relations already known before semantic replay. */
  relationIssues: Array<{
    relation: DecisionRelationName;
    target: string | null;
    reason: DecisionRelationIssueReason;
  }>;
  record: DecisionRecord | null;
};

type ParsedLedgerPhysicalLine = ParsedDecisionLine & {
  /** 1-based physical line number in the persisted JSONL file. */
  lineNumber: number;
};

const JSON_WHITESPACE = new Set([' ', '\t', '\r', '\n']);

type TopLevelScan = {
  /** String values of every VALID-PREFIX top-level `id` key, deduplicated
   *  within the line. Not filtered to a known form so duplicate detection
   *  still catches two malformed or future ids carrying the same bytes. */
  ids: string[];
  /** String values of every VALID-PREFIX top-level `provisional_id` key,
   *  deduplicated within the line. */
  provisionalIds: string[];
  /** String values of every VALID-PREFIX top-level `resolves` key, deduplicated
   *  within the line. Kept apart from `ids`: a resolution target is a
   *  REFERENCE, not this line's identity, so it must never be reserved or
   *  counted as an occurrence of an id. */
  resolvesValues: string[];
  /** String values of every VALID-PREFIX top-level `relates` key, deduplicated
   *  within the line. */
  relatesValues: string[];
  /** Occurrence count per top-level key (duplicates preserved, however the
   *  key was escaped) within the valid prefix. */
  keyCounts: Map<string, number>;
  /** Exact UTF-16 offsets of each top-level value token. Landing uses these
   *  spans to replace only identity-bearing values without reserializing
   *  project-owned extension fields through JavaScript number semantics. */
  valueSpans: Map<string, Array<{ start: number; end: number }>>;
  /** Offset of the top-level closing brace when the whole object is valid. */
  closingBraceIndex: number | null;
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
  const scan: TopLevelScan = {
    ids: [],
    provisionalIds: [],
    resolvesValues: [],
    relatesValues: [],
    keyCounts: new Map(),
    valueSpans: new Map(),
    closingBraceIndex: null,
    complete: false,
  };
  const seenScanIds = new Set<string>();
  const seenScanProvisionalIds = new Set<string>();
  const seenScanResolves = new Set<string>();
  const seenScanRelates = new Set<string>();
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
      const closingBraceIndex = i;
      i += 1;
      skipWs();
      scan.complete = i >= n;
      if (scan.complete) scan.closingBraceIndex = closingBraceIndex;
      return scan;
    }
    if (line[i] !== '"') return scan;
    const key = readString();
    if (key === null) return scan;
    skipWs();
    if (line[i] !== ':') return scan;
    i += 1;
    skipWs();
    const valueStart = i;
    const value = readValue();
    if (value === null) return scan;
    const valueSpans = scan.valueSpans.get(key);
    const valueSpan = { start: valueStart, end: i };
    if (valueSpans) valueSpans.push(valueSpan);
    else scan.valueSpans.set(key, [valueSpan]);
    scan.keyCounts.set(key, (scan.keyCounts.get(key) ?? 0) + 1);
    if (key === 'id' && typeof value === 'string' && !seenScanIds.has(value)) {
      seenScanIds.add(value);
      scan.ids.push(value);
    }
    if (
      key === 'provisional_id'
      && typeof value === 'string'
      && !seenScanProvisionalIds.has(value)
    ) {
      seenScanProvisionalIds.add(value);
      scan.provisionalIds.push(value);
    }
    if (key === 'resolves' && typeof value === 'string' && !seenScanResolves.has(value)) {
      seenScanResolves.add(value);
      scan.resolvesValues.push(value);
    }
    if (key === 'relates' && typeof value === 'string' && !seenScanRelates.has(value)) {
      seenScanRelates.add(value);
      scan.relatesValues.push(value);
    }
    skipWs();
    if (line[i] === ',') { i += 1; continue; }
    if (line[i] === '}') continue;
    return scan;
  }
}

const RECORD_LOAD_BEARING_KEYS = ['id', 'provisional_id', 'ts', 'kind', 'text', 'by'] as const;

type ParsedRelationIssue = {
  relation: DecisionRelationName;
  target: string | null;
  reason: DecisionRelationIssueReason;
};

function parsePersistedRelation(
  source: Record<string, unknown>,
  scan: TopLevelScan,
  relation: DecisionRelationName,
  kind: DecisionKind,
): { target: string | null; issue: ParsedRelationIssue | null } {
  const count = scan.keyCounts.get(relation) ?? 0;
  const scannedValues = relation === 'resolves' ? scan.resolvesValues : scan.relatesValues;
  if (count > 1) {
    return {
      target: null,
      issue: {
        relation,
        target: scannedValues.length === 1 ? scannedValues[0]! : null,
        reason: 'duplicate_field',
      },
    };
  }
  const raw = source[relation];
  if (raw === undefined || raw === null) return { target: null, issue: null };
  if (typeof raw !== 'string' || !isCanonicalDecisionId(raw)) {
    return {
      target: null,
      issue: {
        relation,
        target: typeof raw === 'string' ? raw : null,
        reason: 'invalid_target',
      },
    };
  }
  if (relation === 'resolves' && kind !== 'decided') {
    return {
      target: null,
      issue: {
        relation,
        target: raw,
        reason: 'not_allowed_for_kind',
      },
    };
  }
  return { target: raw, issue: null };
}

function parseDecisionLine(line: string): ParsedDecisionLine {
  const scan = scanTopLevelFields(line);
  const ids = scan.ids;
  const provisionalIds = scan.provisionalIds;
  const resolvesValues = scan.resolvesValues;
  const relatesValues = scan.relatesValues;
  const scannedFields = { ids, provisionalIds, resolvesValues, relatesValues };
  const invalidRecord = (): ParsedDecisionLine => ({
    ...scannedFields,
    relationIssues: [],
    record: null,
  });
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return invalidRecord();
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return invalidRecord();
  }
  // JSON.parse keeps only the LAST of duplicate members, so a repeated
  // CORE key (however escaped) could smuggle conflicting identity, kind,
  // content, or authorship past validation. A repeated relation key is
  // different: the relation becomes unrecognized, but it must not erase the
  // otherwise sound decision content.
  if (!scan.complete) return invalidRecord();
  if (RECORD_LOAD_BEARING_KEYS.some(key => (scan.keyCounts.get(key) ?? 0) > 1)) {
    return invalidRecord();
  }
  const record = parsed as Record<string, unknown>;
  if (!isCanonicalDecisionId(record.id)) return invalidRecord();
  const id = record.id;
  let provisionalId: string | undefined;
  if (record.provisional_id !== undefined && record.provisional_id !== null) {
    // The mapping exists only after landing: an unlanded record already carries
    // its provisional identity in `id`, while a durable record may retain the
    // former handle/ULID exactly once for branch-history traceability.
    if (!isDurableDecisionId(id) || !isProvisionalDecisionId(record.provisional_id)) {
      return invalidRecord();
    }
    provisionalId = record.provisional_id;
  }
  // The recording path always writes a UTC-Z RFC3339 timestamp; a persisted
  // ts that is not one is a malformed line, not a value to display as-is.
  // Date.parse NORMALIZES overflowing components (2026-02-29 -> Mar 1,
  // 24:00 -> next day), so the parsed instant must round-trip to the same
  // second-level components.
  if (typeof record.ts !== 'string' || !UTC_ISO_TS_PATTERN.test(record.ts)) {
    return invalidRecord();
  }
  const parsedInstant = new Date(record.ts);
  if (Number.isNaN(parsedInstant.getTime()) || parsedInstant.toISOString().slice(0, 19) !== record.ts.slice(0, 19)) {
    return invalidRecord();
  }
  if (typeof record.kind !== 'string' || !hasSubstantiveText(record.kind)) {
    return invalidRecord();
  }
  // Only an exact persisted `pending` spelling may create an open obligation.
  // `clarify` and any other older/unknown string kind retain their content as
  // a current decided entry, with the source spelling exposed in the read
  // model. An otherwise valid `resolves` therefore retains decided semantics.
  // Guessing that an unknown kind means pending would fabricate an owner
  // obligation that the persisted vocabulary does not establish.
  const kind: DecisionKind = record.kind === 'pending' ? 'pending' : 'decided';
  const sourceKind = record.kind === 'pending' || record.kind === 'decided'
    ? undefined
    : record.kind;
  // Whitespace-only text is rejected at recording time; a persisted record
  // carrying it is malformed, not an admissible empty-looking decision.
  if (typeof record.text !== 'string' || !hasSubstantiveText(record.text)) {
    return invalidRecord();
  }
  // Persisted authorship must be an explicit nonempty string: rewriting a
  // malformed `by` as "user" would invent provenance in a ledger whose whole
  // point is preserving who decided. (The CLI-side default to "user" applies
  // at RECORDING time, before persistence.)
  if (typeof record.by !== 'string' || !hasSubstantiveText(record.by)) {
    return invalidRecord();
  }
  const parsedResolves = parsePersistedRelation(record, scan, 'resolves', kind);
  const parsedRelates = parsePersistedRelation(record, scan, 'relates', kind);
  const relationIssues = [parsedResolves.issue, parsedRelates.issue]
    .filter((issue): issue is ParsedRelationIssue => issue !== null);
  return {
    ...scannedFields,
    relationIssues,
    record: {
      id,
      ...(provisionalId ? { provisional_id: provisionalId } : {}),
      ts: record.ts,
      kind,
      ...(sourceKind ? { source_kind: sourceKind } : {}),
      text: record.text,
      by: record.by,
      resolves: parsedResolves.target,
      relates: parsedRelates.target,
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

function parseDecisionsLedgerBytes(
  bytes: Buffer,
  displayPath: string,
  exists: boolean,
): DecisionsLedgerSnapshot {
  if (!exists) {
    return {
      path: displayPath,
      exists: false,
      records: [],
      invalid_lines: 0,
      unrecognized_relations: [],
      normalized_kinds: [],
      duplicate_ids: [],
      ambiguous_provisional_ids: [],
      reserved_ids: [],
      reserved_provisional_ids: [],
      highest_durable_sequence: 0,
      unlanded_ids: [],
    };
  }
  const records: DecisionRecord[] = [];
  /** Every id attributable to a line's valid prefix, mapped to the lines
   *  carrying it: the reservation set and duplicate report share one
   *  observation. */
  const idLines = new Map<string, number[]>();
  const provisionalIdLines = new Map<string, number[]>();
  const parsedLines: ParsedLedgerPhysicalLine[] = [];
  let highestDurableSequence = 0;
  // Byte-level split; each line is decoded with fatal UTF-8 so invalid bytes
  // quarantine the line instead of being silently replaced with U+FFFD.
  const rawLines = bytes.toString('binary').split('\n');
  for (const [index, rawLine] of rawLines.entries()) {
    const lineNumber = index + 1;
    const lineBytes = Buffer.from(rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine, 'binary');
    // Blank detection on ASCII whitespace bytes ONLY: a lossy .trim() would
    // also swallow bytes like 0xA0 (latin1 NBSP) and skip a line that fatal
    // decoding must quarantine instead.
    if (lineBytes.every(byte => byte === 0x20 || byte === 0x09 || byte === 0x0d)) continue;
    const decoded = decodeLedgerLine(lineBytes);
    const {
      ids,
      provisionalIds,
      resolvesValues,
      relatesValues,
      relationIssues,
      record,
    } = decoded.text !== null
      ? parseDecisionLine(decoded.text)
      : {
          ...scanTopLevelFields(decoded.validPrefix),
          relationIssues: [],
          record: null,
        };
    parsedLines.push({
      lineNumber,
      ids,
      provisionalIds,
      resolvesValues,
      relatesValues,
      relationIssues,
      record,
    });
    // Reserve every id attributable to the line's valid prefix, quarantined or
    // not, and record where it occurs so repeats are reportable and a current-
    // ledger collision can be redrawn or refused.
    for (const id of ids) {
      const lines = idLines.get(id);
      if (lines) lines.push(lineNumber);
      else idLines.set(id, [lineNumber]);
      const sequence = decisionSequenceNumber(id);
      if (sequence !== null && sequence > highestDurableSequence) {
        highestDurableSequence = sequence;
      }
    }
    for (const provisionalId of provisionalIds) {
      const lines = provisionalIdLines.get(provisionalId);
      if (lines) lines.push(lineNumber);
      else provisionalIdLines.set(provisionalId, [lineNumber]);
    }
  }

  const duplicateIds: DuplicateDecisionId[] = [];
  for (const [id, lines] of idLines) {
    if (lines.length > 1) duplicateIds.push({ id, lines });
  }
  const duplicatedIdSet = new Set(duplicateIds.map(entry => entry.id));

  const ambiguousProvisionalIds: DuplicateDecisionId[] = [];
  for (const [provisionalId, retainedLines] of provisionalIdLines) {
    const currentIdLines = idLines.get(provisionalId) ?? [];
    if (retainedLines.length > 1 || currentIdLines.length > 0) {
      const lines = [...new Set([...retainedLines, ...currentIdLines])]
        .sort((left, right) => left - right);
      ambiguousProvisionalIds.push({ id: provisionalId, lines });
    }
  }
  const ambiguousAliasSet = new Set(ambiguousProvisionalIds.map(entry => entry.id));

  // A branch can be cut after a provisional pending entry is merged but
  // before trunk lands it. If trunk lands first and the branch's later
  // resolver arrives afterward, that resolver still names the old handle.
  // Retained provisional_id mappings let the read model recognize that stale
  // branch reference so the next landing can rewrite it to D<n>. A handle
  // retained on more than one durable record, or reused as a current id, is
  // explicitly ambiguous and never silently selects either target.
  const aliasTargets = new Map<string, string>();
  for (const { lineNumber, record } of parsedLines) {
    if (
      !record?.provisional_id
      || !isDurableDecisionId(record.id)
      || idLines.get(record.id)?.[0] !== lineNumber
      || ambiguousAliasSet.has(record.provisional_id)
    ) {
      continue;
    }
    aliasTargets.set(record.provisional_id, record.id);
  }

  // Semantic replay is deliberately a second pass. A relation can precede a
  // later duplicate after two append-only branch tails are merged, so the full
  // physical file must establish ambiguous identities before any link is
  // allowed to name a target. A bad link degrades independently: its record
  // remains admitted and only the link is ignored.
  const openIds = new Set<string>();
  const admittedRecords = new Map<string, DecisionRecord>();
  const unrecognizedRelations: DecisionRelationIssue[] = [];
  const normalizedKinds: DecisionKindNormalization[] = [];
  let invalidLines = 0;
  for (const { lineNumber, relationIssues, record } of parsedLines) {
    if (!record || idLines.get(record.id)?.[0] !== lineNumber) {
      // Undecodable or malformed line, ambiguous identity, or a repeated id
      // (which would make either relation ambiguous): the first occurrence
      // stays authoritative, later ones are quarantined. This is a record-level
      // defect, unlike the relation-level diagnostics below.
      invalidLines += 1;
      continue;
    }

    if (record.source_kind) {
      normalizedKinds.push({
        line: lineNumber,
        id: record.id,
        source_kind: record.source_kind,
        kind: record.kind,
      });
    }
    for (const issue of relationIssues) {
      unrecognizedRelations.push({
        line: lineNumber,
        id: record.id,
        ...issue,
      });
    }

    const effectiveRecord: DecisionRecord = {
      ...record,
      // Raw structurally-valid relation targets are replayed below. Until each
      // one proves it names an admissible earlier target, it has no effect.
      resolves: null,
      relates: null,
    };
    const resolveTarget = (
      relation: DecisionRelationName,
      rawTarget: string,
    ): { targetId: string; target: DecisionRecord } | null => {
      if (ambiguousAliasSet.has(rawTarget)) {
        unrecognizedRelations.push({
          line: lineNumber,
          id: record.id,
          relation,
          target: rawTarget,
          reason: 'ambiguous_target',
        });
        return null;
      }
      const targetId = idLines.has(rawTarget)
        ? rawTarget
        : aliasTargets.get(rawTarget);
      if (!targetId) {
        unrecognizedRelations.push({
          line: lineNumber,
          id: record.id,
          relation,
          target: rawTarget,
          reason: 'target_not_found',
        });
        return null;
      }
      if (duplicatedIdSet.has(targetId)) {
        unrecognizedRelations.push({
          line: lineNumber,
          id: record.id,
          relation,
          target: rawTarget,
          reason: 'ambiguous_target',
        });
        return null;
      }
      const target = admittedRecords.get(targetId);
      if (!target) {
        const firstTargetLine = idLines.get(targetId)?.[0];
        const reason: DecisionRelationIssueReason = firstTargetLine === undefined
          ? 'target_not_found'
          : (firstTargetLine >= lineNumber ? 'target_not_prior' : 'target_unreadable');
        unrecognizedRelations.push({
          line: lineNumber,
          id: record.id,
          relation,
          target: rawTarget,
          reason,
        });
        return null;
      }
      return { targetId, target };
    };

    if (record.relates !== null) {
      const related = resolveTarget('relates', record.relates);
      if (related) effectiveRecord.relates = related.targetId;
    }
    if (record.resolves !== null) {
      const resolved = resolveTarget('resolves', record.resolves);
      if (resolved) {
        if (resolved.target.kind !== 'pending') {
          unrecognizedRelations.push({
            line: lineNumber,
            id: record.id,
            relation: 'resolves',
            target: record.resolves,
            reason: 'target_not_pending',
          });
        } else if (!openIds.has(resolved.targetId)) {
          unrecognizedRelations.push({
            line: lineNumber,
            id: record.id,
            relation: 'resolves',
            target: record.resolves,
            reason: 'target_already_resolved',
          });
        } else {
          effectiveRecord.resolves = resolved.targetId;
        }
      }
    }

    if (effectiveRecord.kind === 'pending') {
      openIds.add(effectiveRecord.id);
    } else if (effectiveRecord.resolves !== null) {
      openIds.delete(effectiveRecord.resolves);
    }
    records.push(effectiveRecord);
    admittedRecords.set(effectiveRecord.id, effectiveRecord);
  }
  return {
    path: displayPath,
    exists: true,
    records,
    invalid_lines: invalidLines,
    unrecognized_relations: unrecognizedRelations,
    normalized_kinds: normalizedKinds,
    duplicate_ids: duplicateIds,
    ambiguous_provisional_ids: ambiguousProvisionalIds,
    reserved_ids: [...idLines.keys()],
    reserved_provisional_ids: [...provisionalIdLines.keys()],
    highest_durable_sequence: highestDurableSequence,
    unlanded_ids: records.filter(record => isProvisionalDecisionId(record.id)).map(record => record.id),
  };
}

export function readDecisionsLedger(projectRoot: string): DecisionsLedgerSnapshot {
  const filePath = decisionsLedgerPath(projectRoot);
  const displayPath = decisionsLedgerDisplayPath(projectRoot);
  if (!fs.existsSync(filePath)) {
    return parseDecisionsLedgerBytes(Buffer.alloc(0), displayPath, false);
  }
  return parseDecisionsLedgerBytes(fs.readFileSync(filePath), displayPath, true);
}

/** Pending entries not closed by any later decided entry. Oldest first.
 *  (readDecisionsLedger quarantines ambiguous, forward, and replayed
 *  resolutions, so on a snapshot's records the global set below equals
 *  sequential processing.) */
export function openDecisions(records: DecisionRecord[]): DecisionRecord[] {
  const resolved = new Set(
    records
      .filter((record) => record.kind === 'decided' && record.resolves !== null)
      .map((record) => record.resolves as string),
  );
  return records.filter((record) => record.kind === 'pending' && !resolved.has(record.id));
}

/** Presentation order is carried by `ts`, never inferred from a provisional
 *  handle. Equal timestamps preserve physical ledger order. Semantic replay
 *  itself remains physical-order because a resolution may only close an
 *  earlier pending entry. */
export function sortDecisionsByTimestamp(records: DecisionRecord[]): DecisionRecord[] {
  return records
    .map((record, index) => ({ record, index, epochMs: Date.parse(record.ts) }))
    .sort((left, right) => left.epochMs - right.epochMs || left.index - right.index)
    .map(entry => entry.record);
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

/** Cross-process mutual exclusion around record and land mutations. Provisional
 *  identity does not depend on the file, so this is not what makes branch
 *  handles distinct; it keeps each local read-validate-write transition whole.
 *  Two concurrent recorders would otherwise be able to close the same open
 *  pending entry (each validating `--resolves` against a snapshot taken before
 *  the other's append), and a landing rewrite must not race an append. The lock
 *  file carries the holder identity (control metadata, not durable project data
 *  — hence plain writes, mirroring the engine-store file lock).
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
      + `intended entry already recorded (nullius decision list --project-root ${shellQuote(projectRoot)}) — `
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

type LandingLedgerLine = {
  /** Exact bytes before LF, including a CR when the source uses CRLF. */
  raw: Buffer;
  /** Whether this physical segment ended in LF. */
  hasLf: boolean;
  /** Null only for an ASCII-blank physical line. */
  source: Record<string, unknown> | null;
  /** Exact decoded object text excluding a terminal CR. */
  text: string | null;
  /** Field spans for surgical identity rewrites. */
  scan: TopLevelScan | null;
  physicalLineNumber: number;
};

/** Parse every nonblank physical line as a plain object after the strict reader
 *  has certified the ledger. Exact line bytes and terminators are retained so
 *  landing can preserve blank lines and every non-identity byte, including
 *  project-owned extension values that JavaScript could not round-trip
 *  losslessly as numbers. */
function readLedgerLinesForLanding(bytes: Buffer): LandingLedgerLine[] {
  const lines: LandingLedgerLine[] = [];
  const rawLines = bytes.toString('binary').split('\n');
  for (const [index, rawLine] of rawLines.entries()) {
    const raw = Buffer.from(rawLine, 'binary');
    const hasLf = index < rawLines.length - 1;
    const lineBytes = Buffer.from(rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine, 'binary');
    if (lineBytes.every(byte => byte === 0x20 || byte === 0x09 || byte === 0x0d)) {
      lines.push({
        raw,
        hasLf,
        source: null,
        text: null,
        scan: null,
        physicalLineNumber: index + 1,
      });
      continue;
    }
    const decoded = decodeLedgerLine(lineBytes);
    if (decoded.text === null) {
      throw new Error('refusing to land a decision ledger containing invalid UTF-8');
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(decoded.text) as unknown;
    } catch {
      throw new Error('refusing to land a decision ledger containing invalid JSON; no bytes were changed');
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('refusing to land a decision ledger containing a non-object line');
    }
    lines.push({
      raw,
      hasLf,
      source: parsed as Record<string, unknown>,
      text: decoded.text,
      scan: scanTopLevelFields(decoded.text),
      physicalLineNumber: index + 1,
    });
  }
  return lines;
}

type LandingSourceSnapshot = {
  bytes: Buffer;
  dev: number;
  ino: number;
  mode: number;
};

/** Read bytes and inode identity through one fd, then confirm the pathname
 *  still names that inode. This binds the optimistic landing snapshot more
 *  tightly than independent stat/read pathname calls. */
function readLandingSourceSnapshot(filePath: string): LandingSourceSnapshot {
  const fd = fs.openSync(filePath, 'r');
  try {
    const stat = fs.fstatSync(fd);
    const bytes = fs.readFileSync(fd);
    const pathStat = fs.statSync(filePath);
    if (stat.dev !== pathStat.dev || stat.ino !== pathStat.ino) {
      throw new Error('the decisions ledger changed while its landing snapshot was being read');
    }
    return {
      bytes,
      dev: stat.dev,
      ino: stat.ino,
      mode: stat.mode & 0o777,
    };
  } finally {
    fs.closeSync(fd);
  }
}

function assertLandingSourceStillMatches(
  filePath: string,
  source: LandingSourceSnapshot,
  displayPath: string,
): void {
  let current: LandingSourceSnapshot;
  try {
    current = readLandingSourceSnapshot(filePath);
  } catch (error) {
    throw new Error(
      `refusing to land ${displayPath}: the ledger changed while preparing the rewrite; `
      + `no bytes were changed by this command (${error instanceof Error ? error.message : String(error)})`,
    );
  }
  if (
    current.dev !== source.dev
    || current.ino !== source.ino
    || current.mode !== source.mode
    || !current.bytes.equals(source.bytes)
  ) {
    throw new Error(
      `refusing to land ${displayPath}: the ledger changed while preparing the rewrite; `
      + 'no bytes were changed by this command',
    );
  }
}

type LandingTextEdit = {
  start: number;
  end: number;
  replacement: string;
};

function singleLandingValueSpan(
  line: LandingLedgerLine,
  key: string,
): { start: number; end: number } {
  const spans = line.scan?.valueSpans.get(key) ?? [];
  if (spans.length !== 1) {
    throw new Error(
      `refusing to land: physical line ${line.physicalLineNumber} does not carry exactly one `
      + `top-level ${JSON.stringify(key)} value; no bytes were changed`,
    );
  }
  return spans[0]!;
}

/** Rewrite only the top-level identity tokens on one already-certified line.
 *  Applying edits from right to left keeps every recorded source offset valid.
 *  Valid UTF-8 decodes and re-encodes byte-for-byte, while raw JSON spelling,
 *  whitespace, member order, escapes, and extension number lexemes remain
 *  untouched outside the edited spans. */
function rewriteLandingLine(
  line: LandingLedgerLine,
  record: DecisionRecord,
  durableId: string | undefined,
  targetIds: Partial<Record<DecisionRelationName, string>>,
): Buffer {
  if (line.text === null || line.scan === null) {
    throw new Error(
      `refusing to land: physical line ${line.physicalLineNumber} is not a decision object; `
      + 'no bytes were changed',
    );
  }
  const edits: LandingTextEdit[] = [];
  if (durableId) {
    edits.push({
      ...singleLandingValueSpan(line, 'id'),
      replacement: JSON.stringify(durableId),
    });
    const provisionalCount = line.scan.keyCounts.get('provisional_id') ?? 0;
    if (provisionalCount === 0) {
      if (line.scan.closingBraceIndex === null) {
        throw new Error(
          `refusing to land: physical line ${line.physicalLineNumber} has no certified closing brace; `
          + 'no bytes were changed',
        );
      }
      edits.push({
        start: line.scan.closingBraceIndex,
        end: line.scan.closingBraceIndex,
        replacement: `,"provisional_id":${JSON.stringify(record.id)}`,
      });
    } else {
      edits.push({
        ...singleLandingValueSpan(line, 'provisional_id'),
        replacement: JSON.stringify(record.id),
      });
    }
  }
  for (const relation of ['resolves', 'relates'] as const) {
    const targetId = targetIds[relation];
    if (targetId) {
      edits.push({
        ...singleLandingValueSpan(line, relation),
        replacement: JSON.stringify(targetId),
      });
    }
  }
  let rewritten = line.text;
  for (const edit of edits.sort((left, right) => right.start - left.start)) {
    rewritten = `${rewritten.slice(0, edit.start)}${edit.replacement}${rewritten.slice(edit.end)}`;
  }
  const ending = line.raw.length > 0 && line.raw[line.raw.length - 1] === 0x0d
    ? '\r'
    : '';
  return Buffer.from(`${rewritten}${ending}`, 'utf-8');
}

function nextDurableDecisionId(sequence: number): { id: string; sequence: number } {
  if (sequence >= Number.MAX_SAFE_INTEGER) {
    throw new Error(
      `decision id space exhausted (D${sequence} is the largest safe durable id); `
      + 'repair the ledger ids before landing',
    );
  }
  const next = sequence + 1;
  return { id: `D${next}`, sequence: next };
}

/** Fold every admitted provisional entry into the durable trunk sequence.
 *
 *  This is deliberately explicit rather than automatic: the CLI cannot know
 *  which branch is authoritative trunk. The operation refuses any malformed
 *  or duplicate-bearing ledger, builds and self-validates the complete
 *  rewritten JSONL before touching the file, then commits it with one durable
 *  atomic rename. Existing D<n> entries keep their ids, and physical lines
 *  whose identity-bearing fields do not change keep their exact bytes. */
export function landDecisionIds(projectRoot: string): DecisionLandingResult {
  if (!fs.existsSync(path.join(nulliusControlDir(projectRoot), 'state.json'))) {
    throw new Error('project is not initialized (missing state.json in the control dir); run nullius init first');
  }
  return withDecisionsLock(projectRoot, () => {
    const filePath = decisionsLedgerPath(projectRoot);
    const exists = fs.existsSync(filePath);
    const source = exists ? readLandingSourceSnapshot(filePath) : null;
    const sourceBytes = source?.bytes ?? Buffer.alloc(0);
    const snapshot = parseDecisionsLedgerBytes(
      sourceBytes,
      decisionsLedgerDisplayPath(projectRoot),
      exists,
    );
    if (snapshot.duplicate_ids.length > 0) {
      const summary = snapshot.duplicate_ids
        .map(entry => `${entry.id} (lines ${entry.lines.join(', ')})`)
        .join('; ');
      throw new Error(`refusing to land ${snapshot.path}: duplicate decision ids are ambiguous: ${summary}`);
    }
    if (snapshot.ambiguous_provisional_ids.length > 0) {
      const summary = snapshot.ambiguous_provisional_ids
        .map(entry => `${entry.id} (lines ${entry.lines.join(', ')})`)
        .join('; ');
      throw new Error(
        `refusing to land ${snapshot.path}: provisional decision ids are not one-to-one: `
        + `${summary}; no bytes were changed`,
      );
    }
    if (snapshot.invalid_lines > 0) {
      throw new Error(
        `refusing to land ${snapshot.path}: ${snapshot.invalid_lines} unreadable or `
        + 'record-level invalid line(s) must be repaired first; no bytes were changed',
      );
    }
    if (!snapshot.exists) {
      return {
        path: snapshot.path,
        landed: [],
        rewritten_resolutions: 0,
        rewritten_related_links: 0,
      };
    }

    const mapping = new Map<string, string>();
    const landed: DecisionIdLanding[] = [];
    let sequence = snapshot.highest_durable_sequence;
    for (const record of snapshot.records) {
      if (record.provisional_id && isDurableDecisionId(record.id)) {
        mapping.set(record.provisional_id, record.id);
      }
    }
    for (const record of snapshot.records) {
      if (isDurableDecisionId(record.id)) continue;
      const next = nextDurableDecisionId(sequence);
      sequence = next.sequence;
      mapping.set(record.id, next.id);
      landed.push({ provisional_id: record.id, id: next.id });
    }

    const sourceLines = readLedgerLinesForLanding(sourceBytes);
    const sourceRecordCount = sourceLines.filter(line => line.source !== null).length;
    if (sourceRecordCount !== snapshot.records.length) {
      throw new Error(
        `refusing to land ${snapshot.path}: the physical ledger and admitted read model disagree; `
        + 'no bytes were changed',
      );
    }
    const rewrittenChunks: Buffer[] = [];
    let rewrittenResolutions = 0;
    let rewrittenRelatedLinks = 0;
    let recordIndex = 0;
    for (const line of sourceLines) {
      if (line.source === null) {
        rewrittenChunks.push(line.raw);
        if (line.hasLf) rewrittenChunks.push(Buffer.from('\n'));
        continue;
      }
      const source = line.source;
      const record = snapshot.records[recordIndex]!;
      if (source.id !== record.id) {
        throw new Error(
          `refusing to land ${snapshot.path}: physical line ${line.physicalLineNumber} `
          + 'changed while preparing the rewrite; '
          + 'no bytes were changed',
        );
      }
      const durableId = mapping.get(record.id);
      const sourceResolves = (
        line.scan?.keyCounts.get('resolves') === 1
        && typeof source.resolves === 'string'
      ) ? source.resolves : null;
      const sourceRelates = (
        line.scan?.keyCounts.get('relates') === 1
        && typeof source.relates === 'string'
      ) ? source.relates : null;
      const targetIds: Partial<Record<DecisionRelationName, string>> = {
        ...(sourceResolves !== null && mapping.has(sourceResolves)
          ? { resolves: mapping.get(sourceResolves)! }
          : {}),
        ...(sourceRelates !== null && mapping.has(sourceRelates)
          ? { relates: mapping.get(sourceRelates)! }
          : {}),
      };
      if (durableId || targetIds.resolves || targetIds.relates) {
        rewrittenChunks.push(rewriteLandingLine(line, record, durableId, targetIds));
        if (targetIds.resolves) rewrittenResolutions += 1;
        if (targetIds.relates) rewrittenRelatedLinks += 1;
      } else {
        rewrittenChunks.push(line.raw);
      }
      if (line.hasLf) rewrittenChunks.push(Buffer.from('\n'));
      recordIndex += 1;
    }
    const content = Buffer.concat(rewrittenChunks);
    if (content.equals(sourceBytes)) {
      if (landed.length > 0) {
        throw new Error(
          `refusing to land ${snapshot.path}: provisional entries produced no byte changes; `
          + 'no bytes were changed',
        );
      }
      if (source) {
        assertLandingSourceStillMatches(filePath, source, snapshot.path);
        // A prior landing can have completed rename but failed before the
        // parent-directory fsync. A canonical retry must therefore do more
        // than observe the bytes: explicitly persist the current directory
        // entry before reporting a confirmed no-op.
        try {
          fsyncParentDirectoryDurable(filePath);
        } catch (error) {
          throw new Error(
            `decision landing found canonical target bytes in ${snapshot.path}, but could not `
            + 'confirm the directory entry durably; commit status remains uncertain. Run '
            + `\`nullius decision list --project-root ${shellQuote(projectRoot)}\`, then rerun `
            + `\`nullius decision land --project-root ${shellQuote(projectRoot)}\` `
            + `(${error instanceof Error ? error.message : String(error)})`,
          );
        }
        assertLandingSourceStillMatches(filePath, source, snapshot.path);
      }
      return {
        path: snapshot.path,
        landed: [],
        rewritten_resolutions: 0,
        rewritten_related_links: 0,
      };
    }
    if (!source) {
      throw new Error(
        `refusing to land ${snapshot.path}: the ledger disappeared while preparing the rewrite; `
        + 'no bytes were changed by this command',
      );
    }
    if ((source.mode & 0o222) === 0) {
      throw new Error(
        `refusing to land ${snapshot.path}: the ledger mode ${source.mode.toString(8).padStart(4, '0')} `
        + 'has no write bit; no bytes were changed',
      );
    }
    const candidate = parseDecisionsLedgerBytes(content, snapshot.path, true);
    if (
      candidate.invalid_lines !== 0
      || candidate.duplicate_ids.length !== 0
      || candidate.ambiguous_provisional_ids.length !== 0
      || candidate.unlanded_ids.length !== 0
      || candidate.records.length !== snapshot.records.length
    ) {
      throw new Error(
        `refusing to land ${snapshot.path}: the proposed rewrite does not round-trip through `
        + "the ledger's own reader; no bytes were changed",
      );
    }

    // The cooperative lock serializes nullius writers. The commit guard runs
    // only after the staged bytes are fsync'd and closed, at the last portable
    // userspace point before rename, so edits made during preparation are
    // refused rather than overwritten. POSIX has no portable conditional
    // rename: a non-cooperating writer can still race the final check itself
    // and is outside this lock protocol.
    try {
      writeBytesAtomicDurable(
        filePath,
        content,
        source.mode,
        () => assertLandingSourceStillMatches(filePath, source, snapshot.path),
      );
    } catch (error) {
      // rename precedes the parent-directory fsync. If that durability step
      // fails, the target bytes may already be visible and cannot be honestly
      // reported as a zero-write refusal or safely rolled back over a possible
      // foreign edit. Give the operator an explicit commit-uncertain recovery.
      let targetVisible = false;
      try {
        targetVisible = fs.readFileSync(filePath).equals(content);
      } catch {
        // Preserve the original failure below.
      }
      if (targetVisible) {
        throw new Error(
          `decision landing reached the target bytes in ${snapshot.path}, but durable commit `
          + 'confirmation failed after rename; commit status is uncertain. Run '
          + `\`nullius decision list --project-root ${shellQuote(projectRoot)}\`, then rerun `
          + `\`nullius decision land --project-root ${shellQuote(projectRoot)}\` to fsync the `
          + 'parent directory and confirm the canonical ledger '
          + `(${error instanceof Error ? error.message : String(error)})`,
        );
      }
      throw error;
    }
    return {
      path: snapshot.path,
      landed,
      rewritten_resolutions: rewrittenResolutions,
      rewritten_related_links: rewrittenRelatedLinks,
    };
  });
}

export function appendDecision(
  projectRoot: string,
  params: {
    kind: DecisionKind;
    text: string;
    by?: string | null;
    resolves?: string | null;
    relates?: string | null;
  },
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
    const relationTarget = (
      option: '--resolves' | '--relates',
      requestedId: string,
    ): DecisionRecord => {
      // Fail closed on an id the file carries twice. The read model keeps only
      // the first occurrence, so either relation would silently pick one of
      // two different entries.
      const duplicate = snapshot.duplicate_ids.find((entry) => entry.id === requestedId);
      if (duplicate) {
        throw new Error(
          `${option} ${requestedId} is ambiguous: ${snapshot.path} carries that id on lines `
          + `${duplicate.lines.join(', ')}. Reissue every occurrence after the first with a fresh id `
          + '(and repoint any relations naming it) before recording the link.',
        );
      }
      const ambiguousProvisional = snapshot.ambiguous_provisional_ids
        .find((entry) => entry.id === requestedId);
      if (ambiguousProvisional) {
        throw new Error(
          `${option} ${requestedId} is ambiguous: ${snapshot.path} uses that provisional id `
          + `for more than one identity on lines ${ambiguousProvisional.lines.join(', ')}. `
          + 'Keep one durable mapping, reissue any current entry that reused it, and repoint '
          + 'old relations to the intended D<n> before recording the link.',
        );
      }
      const target = snapshot.records.find((record) => record.id === requestedId);
      if (target) return target;
      const landedTarget = snapshot.records.find(
        (record) => record.provisional_id === requestedId,
      );
      if (landedTarget) {
        throw new Error(
          `${option} ${requestedId} was landed as ${landedTarget.id}; `
          + `use ${option} ${landedTarget.id}`,
        );
      }
      throw new Error(`${option} ${requestedId} does not match any recorded decision id`);
    };

    let resolves: string | null = null;
    if (params.resolves) {
      if (params.kind !== 'decided') {
        throw new Error('--resolves is only valid when recording a decision');
      }
      const target = relationTarget('--resolves', params.resolves);
      if (target.kind !== 'pending') {
        throw new Error(`--resolves ${params.resolves} points at a decided entry; only pending entries can be resolved`);
      }
      if (!openDecisions(snapshot.records).some((record) => record.id === target.id)) {
        throw new Error(`--resolves ${params.resolves} is already resolved; only open pending entries can be resolved`);
      }
      resolves = target.id;
    }
    const relates = params.relates
      ? relationTarget('--relates', params.relates).id
      : null;
    const recordedAtMs = Date.now();
    assertRecordableEpochMs(recordedAtMs);
    const record: DecisionRecord = {
      id: mintDecisionHandle(new Set([
        ...snapshot.reserved_ids,
        ...snapshot.reserved_provisional_ids,
      ])),
      ts: utcIsoAt(recordedAtMs),
      kind: params.kind,
      text: trimmed,
      by: params.by && hasSubstantiveText(params.by) ? unicodeTrim(params.by) : 'user',
      resolves,
      relates,
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
