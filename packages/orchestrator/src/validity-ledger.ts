import * as fs from 'node:fs';
import * as path from 'node:path';
import { appendJsonlDurable, mintUlid, withLedgerLock, ULID_PATTERN } from '@nullius/shared';
import type { ValidityEventV1 } from '@nullius/shared';
import type { RunOriginV1 } from '@nullius/shared';

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

export type RunValidity = {
  run_id: string;
  validity: ValidityState;
  superseded_by: string | null;
  reason: string | null;
  scoped_annotations: ScopedAnnotation[];
  stamped: boolean;
  origin: RunOriginV1 | null;
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

function parseLedgerLines(text: string): { parsed: ParsedLine[]; malformed: number } {
  const parsed: ParsedLine[] = [];
  let malformed = 0;
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      const value = JSON.parse(trimmed) as Record<string, unknown>;
      if (
        value.schema_id !== 'validity_event_v1'
        || typeof value.event_id !== 'string'
        || typeof value.event !== 'string'
        || typeof value.run_id !== 'string'
        || typeof value.ts_utc !== 'string'
      ) {
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
        origin: null,
        no_authoritative_identity: false,
      };
      runs.set(runId, entry);
    }
    return entry;
  };

  for (const event of events) {
    const entry = ensure(event.run_id);
    const scope = event.scope ?? 'full';
    switch (event.event) {
      case 'stamp': {
        entry.stamped = true;
        entry.origin = (event.stamp ?? null) as RunOriginV1 | null;
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

export type AppendOutcome = 'appended' | 'already_present';

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
): AppendOutcome {
  if (!ULID_PATTERN.test(event.event_id)) {
    throw new Error(`event_id ${JSON.stringify(event.event_id)} is not a ULID`);
  }
  const ledgerPath = validityLedgerPath(projectRoot);
  return withLedgerLock(ledgerPath, LEDGER_REPAIR_GUIDANCE, () => {
    if (fs.existsSync(ledgerPath)) {
      const { parsed } = parseLedgerLines(fs.readFileSync(ledgerPath, 'utf-8'));
      const incoming = canonicalJson(event);
      for (const { event: existing } of parsed) {
        if (existing.event_id !== event.event_id) continue;
        if (canonicalJson(existing) === incoming) return 'already_present';
        throw new Error(
          `event_id ${event.event_id} already exists in ${ledgerPath} with a different payload; `
          + 'mint a fresh event id for a different event instead of reusing this one',
        );
      }
      // A hand edit can leave the last line unterminated; appending blindly
      // would corrupt both lines. Repair in place (append-only, inode kept).
      const text = fs.readFileSync(ledgerPath, 'utf-8');
      if (text.length > 0 && !text.endsWith('\n')) {
        fs.appendFileSync(ledgerPath, '\n');
      }
    }
    appendJsonlDurable(ledgerPath, event);
    return 'appended';
  });
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
