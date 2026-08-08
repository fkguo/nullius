import * as fs from 'node:fs';
import * as path from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import { appendBytesDurable, appendJsonlDurable, mintUlid, withLedgerLock, writeBytesAtomicDurable, ULID_PATTERN } from '@nullius/shared';
import type { ValidityEventV1 } from '@nullius/shared';
import type { RunOriginV1 } from '@nullius/shared';
import validityEventSchema from '../../../meta/schemas/validity_event_v1.schema.json' with { type: 'json' };
import runOriginSchema from '../../../meta/schemas/run_origin_v1.schema.json' with { type: 'json' };

/** Project validity ledger: the append-only record separating result VALIDITY
 *  ("does this run's result still count") from execution status ("did it
 *  finish"), the two dimensions real projects were found jamming into one
 *  free-text field. One JSON line per event; lines are never rewritten.
 *
 *  Placement: artifacts/runs/validity_ledger.jsonl — research truth versioned
 *  WITH the repository next to the run evidence. (The runtime control dir is
 *  redirectable and mixed-tracked in real projects, so it cannot carry this.)
 *
 *  Direction: the NEW run's author appends `supersede` about the OLD run;
 *  `superseded_by` is derived at read time. Old run directories are never
 *  edited — this one choice clears read-only bits, concurrency on legacy
 *  dirs, and audit in a single move.
 *
 *  Ordering: effective order is ALWAYS re-derived from (ts_utc, event_id),
 *  never from line position, which is what makes `merge=union` a safe merge
 *  driver for this file and both-sides conflict resolution harmless.
 */

export const VALIDITY_LEDGER_RELATIVE_PATH = path.join('artifacts', 'runs', 'validity_ledger.jsonl');

export function validityLedgerPath(projectRoot: string): string {
  return path.join(projectRoot, VALIDITY_LEDGER_RELATIVE_PATH);
}

const LEDGER_REPAIR_GUIDANCE =
  'check whether the intended event already landed (read the tail of validity_ledger.jsonl '
  + 'and look for its event_id).';

/** Deterministic canonical serialization: objects by sorted key, arrays in
 *  place. Two physical lines that differ only in key order or whitespace are
 *  the SAME logical event; anything else sharing an event_id is divergence. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export type ValidityState = 'active' | 'superseded' | 'void';

/** Fixed worst-first severity order used when a ledger-integrity defect
 *  forces a conservative classification. */
const VALIDITY_SEVERITY: Record<ValidityState, number> = { void: 2, superseded: 1, active: 0 };

export function worstValidity(a: ValidityState, b: ValidityState): ValidityState {
  return VALIDITY_SEVERITY[a] >= VALIDITY_SEVERITY[b] ? a : b;
}

export type ScopedAnnotation = {
  scope: string;
  event: 'supersede' | 'void' | 'reinstate';
  by_run_id: string | null;
  reason: string | null;
  event_id: string;
  ts_utc: string;
};

export type AttemptClosure = {
  ordinal: number;
  previous_outcome: 'failed' | 'missing' | 'stalled' | 'declared_no_result';
  evidence_method: 'execution_status' | 'outputs_scan' | 'declared';
  reason: string | null;
  quarantined_to: string | null;
  event_id: string;
  ts_utc: string;
};

/** Execution-attempt bookkeeping for one run. Attempts are HISTORY, never
 *  validity: a run id names one experiment slot, each attempt is one
 *  execution of it with its own launch-time code capture, and the retained
 *  outputs are bound by the HIGHEST-ordinal capture (sound because retry
 *  admission certifies every prior attempt produced no retained result).
 *  Chain logic keys on explicit ordinals and predecessor links only —
 *  sub-millisecond event order is minted, never measured. */
export type RunAttempts = {
  /** Highest ordinal that carries a code binding (1 = the initial stamp). */
  latest_ordinal: number;
  /** Closures whose outcome was a real crash/stall — `missing` self-heals
   *  (stamp-predates-source repairs) never count against attempt budgets. */
  crash_retry_count: number;
  closures: AttemptClosure[];
  /** The latest bound attempt has a recorded closure and nothing newer:
   *  the run crashed and awaits a retry (or was abandoned record-only). */
  latest_failed: boolean;
  /** Ordinal gaps, an opened ordinal without its predecessor's closure, a
   *  closure above the highest binding, or a plain stamp claiming an
   *  ordinal above 1 — conservative, never guessed away. */
  chain_defect: boolean;
  /** Two divergent payloads competing for one ordinal (union merge of two
   *  concurrent retries, or a forged line) — same severity class as
   *  conflicting_stamps. */
  conflicting_attempts: boolean;
};

export type RunValidity = {
  run_id: string;
  validity: ValidityState;
  superseded_by: string | null;
  reason: string | null;
  scoped_annotations: ScopedAnnotation[];
  stamped: boolean;
  attempts: RunAttempts;
  origin: RunOriginV1 | null;
  /** True when more than one stamp event claims this run with DIFFERENT
   *  origin payloads — a reported defect (D9: never resolved by guessing).
   *  `origin` still holds the latest payload for display, flagged as
   *  conflicted. Identical re-stamps (same payload) do not conflict. */
  conflicting_stamps: boolean;
  /** True when a ledger-integrity defect (same event_id, divergent payloads)
   *  touches this run: it has no authoritative effective identity, its
   *  validity above is the WORST candidate state, results-registry rows
   *  naming it are defects, and it contributes a sentinel to the notebook
   *  baseline set. */
  no_authoritative_identity: boolean;
};

export type LedgerIntegrityDefect = {
  event_id: string;
  divergent_line_count: number;
  run_ids: string[];
};

export type ValidityLedgerView = {
  ledger_path: string;
  exists: boolean;
  /** Deduplicated events in effective (ts_utc, event_id) order. */
  events: ValidityEventV1[];
  malformed_lines: number;
  integrity_defects: LedgerIntegrityDefect[];
  /** Derived state per run_id that has at least one ledger event. Runs with
   *  no event at all are the consumer's `unclassified` class (decided there,
   *  because only the directory scan knows which runs exist). */
  runs: Map<string, RunValidity>;
};

type ParsedLine = { raw: string; event: ValidityEventV1 };

const TS_UTC_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

type AjvConstructor = new (options: Record<string, unknown>) => {
  compile: (schema: Record<string, unknown>) => { (value: unknown): boolean; errors?: unknown[] };
  addSchema: (schema: Record<string, unknown>) => unknown;
};
const Ajv2020Ctor = Ajv2020 as unknown as AjvConstructor;

// The checked-in JSON Schemas are the ONE contract; hand-written validators
// were reviewed twice and both times diverged from them in accepting and in
// rejecting directions — that whole class of drift ends by compiling the
// schemas themselves. validateFormats stays off (ajv core has no date-time
// format without the formats package), so the two format-bearing fields are
// re-checked by pattern below alongside the one relation a JSON Schema cannot
// express: a stamp payload must be ABOUT the run its event names.
const eventSchemaValidator = (() => {
  const ajv = new Ajv2020Ctor({ allErrors: false, strict: false, validateFormats: false });
  ajv.addSchema(runOriginSchema as Record<string, unknown>);
  return ajv.compile(validityEventSchema as Record<string, unknown>);
})();

function validateLedgerEvent(value: Record<string, unknown>): boolean {
  if (!eventSchemaValidator(value)) return false;
  if (!TS_UTC_PATTERN.test(String(value.ts_utc))) return false;
  if (value.event === 'stamp') {
    const stamp = value.stamp as Record<string, unknown>;
    if (!TS_UTC_PATTERN.test(String(stamp.captured_at_utc))) return false;
    if (stamp.run_id !== value.run_id) return false;
    // Cross-field relation JSON Schema cannot express: the foreign split
    // is "of untracked_count" — a payload claiming more foreign paths than
    // untracked paths is arithmetically impossible and must be refused,
    // not quietly consumed.
    const dirty = stamp.dirty as Record<string, unknown> | undefined;
    if (dirty && typeof dirty.foreign_run_untracked === 'number'
      && typeof dirty.untracked_count === 'number'
      && dirty.foreign_run_untracked > dirty.untracked_count) {
      return false;
    }
  }
  if (value.event === 'attempt') {
    const record = value.attempt as Record<string, unknown> | undefined;
    const origin = record?.origin as Record<string, unknown> | null | undefined;
    if (origin) {
      // Same ABOUT-relation as stamps: an embedded origin must belong to
      // the run the event names, its capture time must parse, and its
      // ordinal must be exactly the closed ordinal plus one — a payload
      // rebinding another run's code (or teleporting ordinals) is refused
      // at the writer, not merely quarantined by readers.
      if (origin.run_id !== value.run_id) return false;
      if (!TS_UTC_PATTERN.test(String(origin.captured_at_utc))) return false;
      const closes = record?.closes_ordinal;
      if (typeof closes !== 'number' || origin.attempt_ordinal !== closes + 1) return false;
    }
  }
  return true;
}

function parseLedgerLines(text: string): { parsed: ParsedLine[]; malformed: number } {
  const parsed: ParsedLine[] = [];
  let malformed = 0;
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      const value = JSON.parse(trimmed) as Record<string, unknown>;
      if (!validateLedgerEvent(value)) {
        malformed += 1;
        continue;
      }
      parsed.push({ raw: trimmed, event: value as unknown as ValidityEventV1 });
    } catch {
      malformed += 1;
    }
  }
  return { parsed, malformed };
}

/** Read the ledger and derive per-run validity.
 *
 *  Reader obligations (the union-merge safety contract):
 *  - byte-identical duplicate lines are dropped silently;
 *  - lines sharing an event_id whose payloads are canonical-JSON equal are
 *    the same logical event (kept once);
 *  - lines sharing an event_id with DIVERGENT payloads are a fail-closed
 *    ledger-integrity defect: every run either payload names classifies at
 *    the WORST of its candidate states until repaired, and carries
 *    no_authoritative_identity;
 *  - malformed lines are counted, reported, never silently skipped.
 */
export function readValidityLedger(projectRoot: string): ValidityLedgerView {
  const ledgerPath = validityLedgerPath(projectRoot);
  if (!fs.existsSync(ledgerPath)) {
    return {
      ledger_path: ledgerPath,
      exists: false,
      events: [],
      malformed_lines: 0,
      integrity_defects: [],
      runs: new Map(),
    };
  }
  const { parsed, malformed } = parseLedgerLines(fs.readFileSync(ledgerPath, 'utf-8'));

  // Dedup pass: group by event_id, compare canonical forms.
  const byId = new Map<string, { canon: Set<string>; first: ValidityEventV1; lineCount: number }>();
  for (const { event } of parsed) {
    const canon = canonicalJson(event);
    const existing = byId.get(event.event_id);
    if (!existing) {
      byId.set(event.event_id, { canon: new Set([canon]), first: event, lineCount: 1 });
    } else {
      existing.lineCount += 1;
      existing.canon.add(canon);
    }
  }

  const integrityDefects: LedgerIntegrityDefect[] = [];
  const defectRunIds = new Set<string>();
  const defectWorst = new Map<string, ValidityState>();
  const events: ValidityEventV1[] = [];
  const divergentEventIds = new Set<string>();
  for (const [eventId, group] of byId) {
    if (group.canon.size === 1) {
      events.push(group.first);
      continue;
    }
    divergentEventIds.add(eventId);
    // Conservative worst-state derivation per divergent variant: a
    // supersede/void variant makes its target at least superseded/void; a
    // reinstate variant is NOT trusted (trusting a disputed reinstatement
    // would be the non-conservative direction).
    const runIds = new Set<string>();
    for (const { event } of parsed) {
      if (event.event_id !== eventId) continue;
      runIds.add(event.run_id);
      if (event.by_run_id) runIds.add(event.by_run_id);
      const scope = event.scope ?? 'full';
      if (scope !== 'full') continue;
      if (event.event === 'supersede') {
        defectWorst.set(event.run_id, worstValidity(defectWorst.get(event.run_id) ?? 'active', 'superseded'));
      } else if (event.event === 'void') {
        defectWorst.set(event.run_id, worstValidity(defectWorst.get(event.run_id) ?? 'active', 'void'));
      }
    }
    for (const id of runIds) defectRunIds.add(id);
    integrityDefects.push({
      event_id: eventId,
      divergent_line_count: group.lineCount,
      run_ids: [...runIds].sort(),
    });
  }

  // Effective order: (ts_utc, event_id) — never line position.
  events.sort((a, b) => (a.ts_utc < b.ts_utc ? -1 : a.ts_utc > b.ts_utc ? 1
    : a.event_id < b.event_id ? -1 : a.event_id > b.event_id ? 1 : 0));

  const runs = new Map<string, RunValidity>();
  const ensure = (runId: string): RunValidity => {
    let entry = runs.get(runId);
    if (!entry) {
      entry = {
        run_id: runId,
        validity: 'active',
        superseded_by: null,
        reason: null,
        scoped_annotations: [],
        stamped: false,
        attempts: {
          latest_ordinal: 0,
          crash_retry_count: 0,
          closures: [],
          latest_failed: false,
          chain_defect: false,
          conflicting_attempts: false,
        },
        origin: null,
        conflicting_stamps: false,
        no_authoritative_identity: false,
      };
      runs.set(runId, entry);
    }
    return entry;
  };
  // Per-run per-ordinal bookkeeping, resolved AFTER the event loop: the
  // effective origin is the highest-ordinal binding, and chain health is a
  // property of the whole chain, not of any single event.
  const ordinalOrigins = new Map<string, Map<number, RunOriginV1>>();
  const ordinalClosures = new Map<string, Map<number, string>>();
  // The event that OPENED each ordinal (the stamp event for 1, the attempt
  // event whose embedded origin bound k for k>1) and the predecessor link
  // each closure claims — resolved against each other after the stream so
  // `supersedes_attempt_event` is a LOAD-BEARING reference, not decoration.
  const ordinalOpeners = new Map<string, Map<number, string>>();
  const closureLinks = new Map<string, Map<number, string | null>>();
  const bindingFor = (runId: string): Map<number, RunOriginV1> => {
    let m = ordinalOrigins.get(runId);
    if (!m) { m = new Map(); ordinalOrigins.set(runId, m); }
    return m;
  };
  const closuresFor = (runId: string): Map<number, string> => {
    let m = ordinalClosures.get(runId);
    if (!m) { m = new Map(); ordinalClosures.set(runId, m); }
    return m;
  };
  const recordOpener = (runId: string, ordinal: number, eventId: string): void => {
    let m = ordinalOpeners.get(runId);
    if (!m) { m = new Map(); ordinalOpeners.set(runId, m); }
    // First opener in effective order wins — the same resolution rule the
    // retry writer uses to pick its predecessor, so writer and reader
    // agree on what a well-formed link points at.
    if (!m.has(ordinal)) m.set(ordinal, eventId);
  };
  const recordBinding = (entry: RunValidity, ordinal: number, incoming: RunOriginV1): void => {
    const bindings = bindingFor(entry.run_id);
    const existing = bindings.get(ordinal);
    if (existing && canonicalJson(existing) !== canonicalJson(incoming)) {
      // D9 doctrine unchanged: divergence is flagged, and the LATEST payload
      // stays visible for display — flagged as conflicted, never trusted.
      if (ordinal === 1) entry.conflicting_stamps = true;
      else entry.attempts.conflicting_attempts = true;
    }
    bindings.set(ordinal, incoming);
    entry.stamped = true;
  };

  for (const event of events) {
    const entry = ensure(event.run_id);
    const scope = event.scope ?? 'full';
    switch (event.event) {
      case 'stamp': {
        const incoming = (event.stamp ?? null) as RunOriginV1 | null;
        if (incoming) {
          const ordinal = (incoming as { attempt_ordinal?: number }).attempt_ordinal ?? 1;
          if (ordinal !== 1) {
            // A plain stamp may only bind ordinal 1; higher ordinals are
            // legal only embedded in an attempt closure (the entrance that
            // certifies the prior attempt left no retained result).
            entry.attempts.chain_defect = true;
          } else {
            recordBinding(entry, 1, incoming);
            recordOpener(entry.run_id, 1, event.event_id);
          }
        }
        break;
      }
      case 'attempt': {
        const record = (event as { attempt?: {
          closes_ordinal: number;
          previous_outcome: AttemptClosure['previous_outcome'];
          evidence: { method: AttemptClosure['evidence_method']; detail: string };
          quarantined_to: string | null;
          supersedes_attempt_event: string | null;
          origin: RunOriginV1 | null;
        } }).attempt;
        if (!record) break; // schema-guarded; a malformed line never reaches here
        const closures = closuresFor(entry.run_id);
        const canon = canonicalJson({ ...record, origin: undefined });
        const existing = closures.get(record.closes_ordinal);
        if (existing !== undefined && existing !== canon) {
          entry.attempts.conflicting_attempts = true;
        } else if (existing === undefined) {
          closures.set(record.closes_ordinal, canon);
          let links = closureLinks.get(entry.run_id);
          if (!links) { links = new Map(); closureLinks.set(entry.run_id, links); }
          links.set(record.closes_ordinal, record.supersedes_attempt_event);
          entry.attempts.closures.push({
            ordinal: record.closes_ordinal,
            previous_outcome: record.previous_outcome,
            evidence_method: record.evidence.method,
            reason: event.reason ?? null,
            quarantined_to: record.quarantined_to,
            event_id: event.event_id,
            ts_utc: event.ts_utc,
          });
          if (record.previous_outcome !== 'missing') {
            entry.attempts.crash_retry_count += 1;
          }
        }
        if (record.origin) {
          const openedOrdinal = (record.origin as { attempt_ordinal?: number }).attempt_ordinal ?? null;
          const originRunId = (record.origin as { run_id?: string }).run_id ?? null;
          if (openedOrdinal !== record.closes_ordinal + 1
            || originRunId !== event.run_id
            // A retry always knows what it closes: the initial stamp for
            // ordinal 1, the opening attempt event otherwise. A null
            // predecessor on an OPENING closure is a forged or hand-built
            // line — conservative defect, binding never promoted.
            || record.supersedes_attempt_event === null) {
            entry.attempts.chain_defect = true;
          } else {
            recordBinding(entry, openedOrdinal, record.origin);
            recordOpener(entry.run_id, openedOrdinal, event.event_id);
          }
        }
        break;
      }
      case 'supersede': {
        if (event.by_run_id) ensure(event.by_run_id);
        if (scope === 'full') {
          entry.validity = 'superseded';
          entry.superseded_by = event.by_run_id ?? null;
          entry.reason = event.reason ?? null;
        } else {
          entry.scoped_annotations.push({
            scope,
            event: 'supersede',
            by_run_id: event.by_run_id ?? null,
            reason: event.reason ?? null,
            event_id: event.event_id,
            ts_utc: event.ts_utc,
          });
        }
        break;
      }
      case 'void': {
        if (scope === 'full') {
          entry.validity = 'void';
          entry.superseded_by = null;
          entry.reason = event.reason ?? null;
        } else {
          entry.scoped_annotations.push({
            scope,
            event: 'void',
            by_run_id: null,
            reason: event.reason ?? null,
            event_id: event.event_id,
            ts_utc: event.ts_utc,
          });
        }
        break;
      }
      case 'reinstate': {
        // Schema pins reinstate to full scope; last full-scope event wins.
        entry.validity = 'active';
        entry.superseded_by = null;
        entry.reason = event.reason ?? null;
        break;
      }
    }
  }

  // Resolve attempt chains AFTER the whole event stream: the effective
  // origin is the highest-ordinal binding, and chain health is a property
  // of the complete chain (gaps, missing predecessor closures, closures of
  // never-opened ordinals) — conservative flags, none guessed away.
  for (const [runId, bindings] of ordinalOrigins) {
    const entry = ensure(runId);
    const ordinals = [...bindings.keys()].sort((a, b) => a - b);
    const latest = ordinals[ordinals.length - 1]!;
    entry.attempts.latest_ordinal = latest;
    entry.origin = bindings.get(latest) ?? null;
    const closures = ordinalClosures.get(runId) ?? new Map<number, string>();
    // ROOTED chains only: every chain begins at the initial plain stamp.
    // An attempt-embedded binding with no ordinal-1 record (a dropped,
    // malformed, or never-written stamp line) must never read as a clean
    // authoritative origin — that would mint provenance out of one line.
    if (!bindings.has(1)) entry.attempts.chain_defect = true;
    for (let k = 2; k <= latest; k += 1) {
      if (!bindings.has(k)) entry.attempts.chain_defect = true;
      if (!closures.has(k - 1)) entry.attempts.chain_defect = true;
    }
    for (const closedOrdinal of closures.keys()) {
      if (closedOrdinal > latest) entry.attempts.chain_defect = true;
    }
    entry.attempts.latest_failed = closures.has(latest);
  }
  for (const [runId, closures] of ordinalClosures) {
    if (!ordinalOrigins.has(runId) && closures.size > 0) {
      // A closure with no binding at all: history about an attempt the
      // ledger never saw opened.
      ensure(runId).attempts.chain_defect = true;
    }
  }
  // Predecessor links are load-bearing: every closure must name the event
  // that actually OPENED the ordinal it closes. A null link, a link to a
  // nonexistent event, or a link to the wrong event is a forged or
  // hand-built line — conservative defect, applied to record-only closures
  // too (the machine writer always resolves its predecessor or refuses).
  for (const [runId, links] of closureLinks) {
    const entry = ensure(runId);
    const openers = ordinalOpeners.get(runId);
    for (const [ordinal, link] of links) {
      if (link === null || openers?.get(ordinal) !== link) {
        entry.attempts.chain_defect = true;
      }
    }
  }

  for (const runId of defectRunIds) {
    const entry = ensure(runId);
    entry.no_authoritative_identity = true;
    const worst = defectWorst.get(runId);
    if (worst) entry.validity = worstValidity(entry.validity, worst);
  }

  return {
    ledger_path: ledgerPath,
    exists: true,
    events,
    malformed_lines: malformed,
    integrity_defects: integrityDefects.sort((a, b) => a.event_id.localeCompare(b.event_id)),
    runs,
  };
}

export type AppendOutcome = 'appended' | 'already_present' | 'skipped_run_already_stamped' | 'skipped_attempt_not_chain_head';

export type AppendValidityEventOptions = {
  /** Stamp-writer guard, evaluated INSIDE the ledger lock: refuse to append
   *  when ANY stamp event for this run_id is already on the ledger, returning
   *  'skipped_run_already_stamped' instead. One run id carries one stamp —
   *  a second, byte-different payload is the reader's conflicting-stamps
   *  defect, so the race two concurrent stampers would otherwise run
   *  (both read "unstamped", both append) is closed at the only place that
   *  can close it atomically. The equal-event-id idempotency check still
   *  runs first: a crash-retry of the SAME logical stamp stays a no-op
   *  success, never a skip. */
  onlyIfRunUnstamped?: boolean;
  /** attempt events: append only when the closed ordinal is the CURRENT
   *  chain head (highest bound ordinal) and no closure for it exists yet —
   *  the same in-lock atomicity that onlyIfRunUnstamped gives the first
   *  stamp, extended one level down. Two concurrent retries race to one
   *  append; the loser is skipped instead of manufacturing the divergence
   *  the reader would have to quarantine. The guarded ordinal is read from
   *  the EVENT's own closes_ordinal — a separately supplied number could
   *  drift from what the line actually says and guard the wrong ordinal. */
  onlyIfAttemptChainHead?: boolean;
};

/** Append one event under the ledger's own lock.
 *
 *  Idempotency: one ULID identifies one logical event for life. If the
 *  event_id already exists with a canonically equal payload, the append is a
 *  no-op success (safe retry, including cross-process crash recovery via a
 *  caller-supplied event_id). If it exists with a DIFFERENT payload, the
 *  append is refused — the writer must mint a fresh id for what is actually
 *  a different event, rather than manufacturing the divergence the reader
 *  would then have to quarantine.
 */
export function appendValidityEvent(
  projectRoot: string,
  event: ValidityEventV1,
  options: AppendValidityEventOptions = {},
): AppendOutcome {
  if (!ULID_PATTERN.test(event.event_id)) {
    throw new Error(`event_id ${JSON.stringify(event.event_id)} is not a ULID`);
  }
  // Writer-side schema gate (stage-2 acceptance hook, native r4 nb#1): the
  // compiled validator that guards every read also guards the write, so a
  // schema-invalid event is refused HERE instead of being appended and then
  // permanently quarantined as a malformed line by every future reader.
  if (!validateLedgerEvent(event as unknown as Record<string, unknown>)) {
    throw new Error(
      'event does not validate against validity_event_v1 (schema-compiled check); '
      + 'refusing to append a line every reader would only quarantine',
    );
  }
  const ledgerPath = validityLedgerPath(projectRoot);
  // The lock file lives next to the ledger; on a project whose artifacts/runs
  // does not exist yet (e.g. only team/runs so far), the O_EXCL create would
  // fail on the missing parent before any append could create it.
  fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
  ensureLedgerMergeAttributes(projectRoot);
  return withLedgerLock(ledgerPath, LEDGER_REPAIR_GUIDANCE, () => {
    if (fs.existsSync(ledgerPath)) {
      const { parsed } = parseLedgerLines(fs.readFileSync(ledgerPath, 'utf-8'));
      const incoming = canonicalJson(event);
      // Inspect EVERY line carrying this event_id before deciding: a matching
      // duplicate must not short-circuit past a later divergent line (that
      // divergence is exactly what the writer must refuse to extend).
      const sameId = parsed.filter(({ event: existing }) => existing.event_id === event.event_id);
      if (sameId.length > 0) {
        const divergent = sameId.some(({ event: existing }) => canonicalJson(existing) !== incoming);
        if (divergent) {
          throw new Error(
            `event_id ${event.event_id} already exists in ${ledgerPath} with a different payload; `
            + 'mint a fresh event id for a different event instead of reusing this one',
          );
        }
        return 'already_present';
      }
      if (options.onlyIfRunUnstamped
        && parsed.some(({ event: existing }) => existing.event === 'stamp' && existing.run_id === event.run_id)) {
        return 'skipped_run_already_stamped';
      }
      if (options.onlyIfAttemptChainHead) {
        const target = (event as { attempt?: { closes_ordinal?: number } }).attempt?.closes_ordinal;
        if (typeof target !== 'number') {
          throw new Error('onlyIfAttemptChainHead requires an attempt event carrying closes_ordinal');
        }
        let latestOrdinal = 0;
        let closureExists = false;
        for (const { event: existing } of parsed) {
          if (existing.run_id !== event.run_id) continue;
          if (existing.event === 'stamp' && existing.stamp) {
            const ordinal = (existing.stamp as { attempt_ordinal?: number }).attempt_ordinal ?? 1;
            if (ordinal === 1 && latestOrdinal < 1) latestOrdinal = 1;
          } else if (existing.event === 'attempt') {
            const record = (existing as { attempt?: { closes_ordinal: number; origin: unknown | null } }).attempt;
            if (!record) continue;
            if (record.closes_ordinal === target) closureExists = true;
            if (record.origin) {
              const opened = (record.origin as { attempt_ordinal?: number }).attempt_ordinal ?? 0;
              if (opened > latestOrdinal) latestOrdinal = opened;
            }
          }
        }
        if (latestOrdinal !== target || closureExists) {
          return 'skipped_attempt_not_chain_head';
        }
      }
      // A hand edit can leave the last line unterminated; appending blindly
      // would corrupt both lines. Repair in place (append-only, inode kept).
      const text = fs.readFileSync(ledgerPath, 'utf-8');
      if (text.length > 0 && !text.endsWith('\n')) {
        appendBytesDurable(ledgerPath, '\n');
      }
    }
    appendJsonlDurable(ledgerPath, event);
    return 'appended';
  });
}

/** The D3 merge contract is only real if the repository actually carries the
 *  union-merge declaration — assuming it exists is not delivering it. The
 *  writer maintains a small .gitattributes next to the ledger (idempotent;
 *  never overwrites a hand-customized line). Union merge is safe here
 *  because lines are self-contained, id-deduplicated by the reader, and
 *  order-independent (effective order is re-derived from ts_utc, event_id). */
export function ensureLedgerMergeAttributes(projectRoot: string): void {
  const attributesPath = path.join(projectRoot, 'artifacts', 'runs', '.gitattributes');
  const line = 'validity_ledger.jsonl merge=union';
  try {
    if (fs.existsSync(attributesPath)) {
      const text = fs.readFileSync(attributesPath, 'utf-8');
      if (text.split('\n').some(existing => existing.trim().startsWith('validity_ledger.jsonl'))) return;
      appendBytesDurable(attributesPath, `${text.endsWith('\n') || text.length === 0 ? '' : '\n'}${line}\n`);
      return;
    }
    writeBytesAtomicDurable(attributesPath, `${line}\n`);
  } catch {
    // Best-effort: an unwritable attributes file must not block the append;
    // without it a branch merge conflicts loudly instead of silently, which
    // is the safe direction.
  }
}

/** Build a validity event with a freshly minted id (or a caller-supplied one
 *  for retries of the same logical event). */
export function buildValidityEvent(
  fields: Omit<ValidityEventV1, 'schema_id' | 'event_id' | 'ts_utc'>
    & { event_id?: string; ts_utc?: string },
): ValidityEventV1 {
  return {
    schema_id: 'validity_event_v1',
    event_id: fields.event_id ?? mintUlid(),
    ts_utc: fields.ts_utc ?? new Date().toISOString(),
    ...Object.fromEntries(
      Object.entries(fields).filter(([k]) => k !== 'event_id' && k !== 'ts_utc'),
    ),
  } as ValidityEventV1;
}
