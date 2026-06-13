// Failed-approaches log (ABSORB #3 — long-running compute survival).
//
// The research-harness survival protocol already covers checkpoint-per-unit + resume,
// the self-re-arming heartbeat, the liveness probe, and livelock re-decomposition. The one
// MISSING piece was a durable record of approaches already TRIED AND FAILED: today it lives
// only in git commit messages + a free-text dead-end note, which a resumed or fresh agent
// cannot reliably consult. This is the structured, checkable `failed_approaches_v1` record:
// append on each dead-end, read before launching a new approach, skip the do_not_retry ones.
//
// Anti-noise invariant (appendFailedApproach + the parser): every entry MUST carry a
// non-empty `why_failed` (and a non-empty `approach` + a known `signal`). A dead-end logged
// without WHY it failed is not a reusable lesson — it is rejected. That keeps the log a
// record of lessons, not a pile of "tried X" with no takeaway.
//
// Style mirrors staged-content.ts / claim-grounding.ts / literature-survey.ts: locally
// defined types + a hand-rolled safeParse/parse (no zod), crash-safe on malformed input.

export type FailureSignal =
  | 'error'          // crashed / threw / non-zero exit
  | 'stall'          // livelock: no progress across probe windows
  | 'wrong_result'   // ran, but the output was wrong / failed verification
  | 'too_expensive'  // would not finish within budget (time / memory / cost)
  | 'dead_end'       // logically cannot work / contradicted by evidence
  | 'superseded';    // replaced by a better approach (kept so it is not re-tried)

export type FailedApproach = {
  /** What was tried (non-empty). */
  approach: string;
  /** Why it failed — the reusable lesson (non-empty; an entry without this is rejected). */
  why_failed: string;
  signal: FailureSignal;
  /** ISO-8601 UTC timestamp; caller-supplied (kept out of the helpers for determinism). */
  at: string;
  /** Pointer to the evidence: commit sha / artifact path / log path. */
  evidence_ref?: string;
  /** Whether a later agent should avoid re-trying this. Defaults true on append. */
  do_not_retry: boolean;
};

export type FailedApproachesV1 = {
  version: 1;
  run_id?: string;
  /** The problem these dead-ends were explored against. */
  topic?: string;
  approaches: FailedApproach[];
};

export const FAILURE_SIGNALS: readonly FailureSignal[] = [
  'error',
  'stall',
  'wrong_result',
  'too_expensive',
  'dead_end',
  'superseded',
];

// ─── Pure helpers ───

export function createFailedApproachesLog(opts?: { run_id?: string; topic?: string }): FailedApproachesV1 {
  return {
    version: 1,
    ...(opts?.run_id !== undefined ? { run_id: opts.run_id } : {}),
    ...(opts?.topic !== undefined ? { topic: opts.topic } : {}),
    approaches: [],
  };
}

export type FailedApproachInput = {
  approach: string;
  why_failed: string;
  signal: FailureSignal;
  at: string;
  evidence_ref?: string;
  do_not_retry?: boolean;
};

/** Append a dead-end to the log (pure — returns a new log). Enforces the anti-noise
 *  invariant: throws if `approach`/`why_failed` is empty or `signal` is unknown, so a
 *  lesson-less entry cannot enter the record. `do_not_retry` defaults to true. */
export function appendFailedApproach(log: FailedApproachesV1, entry: FailedApproachInput): FailedApproachesV1 {
  if (typeof entry.approach !== 'string' || entry.approach.trim().length === 0) {
    throw new Error('failed_approaches: `approach` must be a non-empty string');
  }
  if (typeof entry.why_failed !== 'string' || entry.why_failed.trim().length === 0) {
    throw new Error('failed_approaches: `why_failed` must be a non-empty string (a dead-end without a lesson is not loggable)');
  }
  if (!FAILURE_SIGNALS.includes(entry.signal)) {
    throw new Error(`failed_approaches: \`signal\` must be one of ${FAILURE_SIGNALS.join(', ')}`);
  }
  if (typeof entry.at !== 'string' || entry.at.trim().length === 0) {
    throw new Error('failed_approaches: `at` must be a non-empty timestamp string');
  }
  const appended: FailedApproach = {
    approach: entry.approach,
    why_failed: entry.why_failed,
    signal: entry.signal,
    at: entry.at,
    ...(entry.evidence_ref !== undefined ? { evidence_ref: entry.evidence_ref } : {}),
    do_not_retry: entry.do_not_retry ?? true,
  };
  return { ...log, approaches: [...log.approaches, appended] };
}

/** The approaches a later agent should NOT re-try — the "read before a new approach" list.
 *  Defensive against malformed/raw input (also reachable with parsed JSON). */
export function blockedApproaches(log: Pick<FailedApproachesV1, 'approaches'>): string[] {
  const list = Array.isArray(log?.approaches) ? log.approaches : [];
  return list
    .filter((a): a is FailedApproach => isObject(a) && a.do_not_retry === true && typeof a.approach === 'string')
    .map(a => a.approach);
}

// ─── Validation (hand-rolled, mirrors the sibling shared parsers) ───

export type FailedApproachesParseIssue = { path: string; message: string };
type ParseSuccess = { ok: true; value: FailedApproachesV1 };
type ParseFailure = { ok: false; issues: FailedApproachesParseIssue[] };

function issue(path: string, message: string): FailedApproachesParseIssue {
  return { path, message };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function validateApproach(entry: unknown, path: string, issues: FailedApproachesParseIssue[]): void {
  if (!isObject(entry)) {
    issues.push(issue(path, 'must be an object'));
    return;
  }
  if (!isNonEmptyString(entry.approach)) issues.push(issue(`${path}.approach`, 'must be a non-empty string'));
  // The anti-noise invariant, re-asserted at the contract boundary.
  if (!isNonEmptyString(entry.why_failed)) {
    issues.push(issue(`${path}.why_failed`, 'must be a non-empty string (a dead-end without a lesson is not loggable)'));
  }
  if (!FAILURE_SIGNALS.includes(entry.signal as FailureSignal)) {
    issues.push(issue(`${path}.signal`, `must be one of ${FAILURE_SIGNALS.join(', ')}`));
  }
  if (!isNonEmptyString(entry.at)) issues.push(issue(`${path}.at`, 'must be a non-empty string'));
  if (entry.evidence_ref !== undefined && typeof entry.evidence_ref !== 'string') {
    issues.push(issue(`${path}.evidence_ref`, 'must be a string when provided'));
  }
  if (typeof entry.do_not_retry !== 'boolean') issues.push(issue(`${path}.do_not_retry`, 'must be a boolean'));
}

export function safeParseFailedApproachesV1(value: unknown): ParseSuccess | ParseFailure {
  const issues: FailedApproachesParseIssue[] = [];
  if (!isObject(value)) {
    return { ok: false, issues: [issue('', 'must be a JSON object')] };
  }
  if (value.version !== 1) issues.push(issue('version', 'must equal 1'));
  if (value.run_id !== undefined && typeof value.run_id !== 'string') {
    issues.push(issue('run_id', 'must be a string when provided'));
  }
  if (value.topic !== undefined && typeof value.topic !== 'string') {
    issues.push(issue('topic', 'must be a string when provided'));
  }
  if (!Array.isArray(value.approaches)) {
    issues.push(issue('approaches', 'must be an array'));
  } else {
    value.approaches.forEach((entry, i) => validateApproach(entry, `approaches[${i}]`, issues));
  }
  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, value: value as unknown as FailedApproachesV1 };
}

export function parseFailedApproachesV1(value: unknown): FailedApproachesV1 {
  const parsed = safeParseFailedApproachesV1(value);
  if (parsed.ok) return parsed.value;
  throw new Error(parsed.issues.map(entry => `${entry.path || '<root>'}: ${entry.message}`).join('; '));
}
