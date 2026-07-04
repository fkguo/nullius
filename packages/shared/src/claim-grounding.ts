// Claim-grounding contract (ABSORB #2).
//
// Active "statement-support grounding": given a claim and the cited sources it
// leans on, did the cited source CONTENT actually substantiate the claim? This is
// the (G) level — distinct from existence (E), citation stance (S), and metadata
// (M), all of which the provider tools already cover. The deliverable is a
// `claim_grounding_report_v1` artifact: per-claim verdicts, each backed by a
// VERBATIM span quoted from the fetched source.
//
// Anti-fakery invariant (assembleClaimGroundingReport / enforceSpanRule): a
// `substantiated` or `partial` verdict that carries no verbatim supporting span is
// DOWNGRADED to `not_substantiated`. You cannot mark a claim grounded without
// quoting the source text that grounds it — that keeps every "grounded" verdict
// independently re-checkable against the source.
//
// Numeric-match invariant (enforceNumericMatchRule; execution semantics in
// numeric-claim-match.ts): a `numeric_match` entry claiming support
// (substantiated/partial) must carry a recorded `numeric_comparison`, and the
// comparison verdict is DERIVED — recomputed from the recorded comparison
// input, never trusted as supplied (mirror of the verification_status rule).
// Coupling is mechanical on both sides (assemble downgrades; parse rejects):
//   - comparison `mismatch`      → the grounding verdict cannot be
//     substantiated/partial (downgraded to `conflicting`: the source value
//     actively contradicts the claimed value);
//   - comparison `incomparable`  → the grounding verdict cannot be
//     `substantiated` (downgraded to `not_substantiated`);
//   - method `numeric_match` with a substantiated/partial verdict but NO
//     recorded comparison → downgraded to `not_substantiated` (same shape as
//     the span rule: a numeric match you did not compute does not exist).
// The span rule applies to `numeric_match` entries unchanged — the source
// value's verbatim context still has to be quoted.
// Comparison verdict + decision_path are the load-bearing recomputed outcome;
// the numeric detail fields (deviation, tolerance, sigma distance) are an
// ADVISORY audit trail, validated for type/finiteness only (cross-language JSON
// writers may re-serialize floats) — never trust a detail magnitude that the
// recorded input does not reproduce.
//
// Style mirrors staged-content.ts: locally-defined types + a hand-rolled
// safeParse/parse (no zod) — the same runtime-parser shape used across the shared
// *-bridge / verification-lift modules.

import {
  compareNumericClaim,
  NUMERIC_COMPARISON_DECISION_PATHS,
  NUMERIC_COMPARISON_VERDICTS,
  NUMERIC_TOLERANCE_KINDS,
  type NumericClaimComparisonDetails,
  type NumericClaimComparisonInput,
  type NumericComparisonDecisionPath,
  type NumericComparisonVerdict,
} from './numeric-claim-match.js';

export type ClaimGroundingVerdict =
  | 'substantiated'
  | 'partial'
  | 'not_substantiated'
  | 'conflicting'
  | 'source_unavailable';

export type ClaimGroundingMethod = 'text_entailment' | 'numeric_match' | 'existence_only';

export type EvidenceDomain = 'hep' | 'general';

export type ClaimVerificationStatus = 'verified' | 'unverified' | 'falsified';

export type ClaimSupportingSpan = {
  /** Which cited source this verbatim span was taken from. */
  evidence_uri: string;
  /** Verbatim excerpt from the fetched source that bears on the claim. */
  quote: string;
  /** Optional in-source locator: section / equation / table / figure / page. */
  locator?: string;
};

/** Recorded numeric comparison for a `numeric_match` entry. The `input` is what
 *  the agent compared (claimed vs. source value, in the SAME units/conventions —
 *  see numeric-claim-match.ts); `verdict` and `details` are DERIVED from it via
 *  `compareNumericClaim` (assemble recomputes them; parse rejects a recorded
 *  verdict/decision_path that the recorded input does not reproduce). */
export type ClaimNumericComparison = {
  input: NumericClaimComparisonInput;
  verdict: NumericComparisonVerdict;
  details: NumericClaimComparisonDetails;
};

/** Assemble-side input form of ClaimNumericComparison: only the comparison input
 *  is load-bearing; any supplied verdict/details are ignored and recomputed. */
export type ClaimNumericComparisonInputRecord = {
  input: NumericClaimComparisonInput;
  verdict?: NumericComparisonVerdict;
  details?: NumericClaimComparisonDetails;
};

export type ClaimGroundingEntry = {
  /** Index into the source claims[] this entry grounds. */
  claim_index: number;
  claim_text: string;
  /** Mirrors the idea-card claim.support_type. */
  support_type: string;
  /** All cited uris the claim leans on. */
  evidence_uris: string[];
  domain: EvidenceDomain;
  method: ClaimGroundingMethod;
  verdict: ClaimGroundingVerdict;
  /** Verbatim spans; REQUIRED non-empty for substantiated/partial (enforced). */
  supporting_spans: ClaimSupportingSpan[];
  /** Derived from verdict — never agent-supplied (single source of truth). */
  verification_status: ClaimVerificationStatus;
  /** Only allowed (and, for substantiated/partial, REQUIRED) when method is
   *  'numeric_match'. Couples the grounding verdict to the computed comparison. */
  numeric_comparison?: ClaimNumericComparison;
  notes?: string;
};

export type ClaimGroundingSummary = {
  total: number;
  by_verdict: Record<ClaimGroundingVerdict, number>;
  /** 0..1, higher = more ungrounded risk (weighted mean over entries). */
  grounding_risk_score: number;
};

export type ClaimGroundingReportV1 = {
  version: 1;
  /** ISO-8601 UTC timestamp; caller-supplied (kept out of the helpers for determinism). */
  generated_at: string;
  /** Where the grounded claims came from (idea-card uri / run-dir path). */
  source_ref?: string;
  claims: ClaimGroundingEntry[];
  summary: ClaimGroundingSummary;
};

export const CLAIM_GROUNDING_VERDICTS: readonly ClaimGroundingVerdict[] = [
  'substantiated',
  'partial',
  'not_substantiated',
  'conflicting',
  'source_unavailable',
];

const GROUNDING_METHODS: readonly ClaimGroundingMethod[] = ['text_entailment', 'numeric_match', 'existence_only'];
const EVIDENCE_DOMAINS: readonly EvidenceDomain[] = ['hep', 'general'];
const VERIFICATION_STATUSES: readonly ClaimVerificationStatus[] = ['verified', 'unverified', 'falsified'];

/** Risk weight per verdict (0 = fully grounded, 1 = actively contradicted). */
const RISK_WEIGHT: Record<ClaimGroundingVerdict, number> = {
  substantiated: 0,
  partial: 0.5,
  source_unavailable: 0.6,
  not_substantiated: 0.8,
  conflicting: 1,
};

// ─── Pure helpers ───

/** Heuristic routing hint: HEP sources resolve mostly via INSPIRE, so existence is
 *  near-solved there and numeric claims can later be matched against PDG/HEPData.
 *  General sources route through arXiv/OpenAlex. A hint only — the skill may override. */
export function classifyEvidenceDomain(uri: string): EvidenceDomain {
  const u = uri.toLowerCase();
  if (
    u.includes('inspirehep.net')
    || u.includes('inspirehep')
    || /\bhep-(ph|ex|th|lat)\b/.test(u)
    || /arxiv\.org\/abs\/hep-/.test(u)
  ) {
    return 'hep';
  }
  return 'general';
}

/** Map a grounding verdict to the idea-card claim.verification_status field.
 *  Only an active source contradiction (`conflicting`) falsifies a claim; a citation
 *  that merely fails to support it leaves the claim `unverified`, not disproven. */
export function verdictToVerificationStatus(verdict: ClaimGroundingVerdict): ClaimVerificationStatus {
  switch (verdict) {
    case 'substantiated':
      return 'verified';
    case 'conflicting':
      return 'falsified';
    case 'partial':
    case 'not_substantiated':
    case 'source_unavailable':
      return 'unverified';
  }
}

function hasVerbatimSpan(spans: readonly unknown[]): boolean {
  // Defensive: this runs on already-typed entries (enforceSpanRule) AND on raw parsed
  // JSON at the contract boundary (validateEntry), where an element may be null/undefined
  // or a non-object. Guard before dereferencing so safeParse rejects (not throws) on it.
  return spans.some(span => isObject(span) && typeof span.quote === 'string' && span.quote.trim().length > 0);
}

function appendNote(existing: string | undefined, addition: string): string {
  return existing && existing.trim().length > 0 ? `${existing}; ${addition}` : addition;
}

/** Anti-fakery invariant: a substantiated/partial verdict with no verbatim span is
 *  downgraded to not_substantiated (and verification_status recomputed). */
export function enforceSpanRule(entry: ClaimGroundingEntry): ClaimGroundingEntry {
  if ((entry.verdict === 'substantiated' || entry.verdict === 'partial') && !hasVerbatimSpan(entry.supporting_spans)) {
    return {
      ...entry,
      verdict: 'not_substantiated',
      verification_status: verdictToVerificationStatus('not_substantiated'),
      notes: appendNote(entry.notes, 'downgraded to not_substantiated: no verbatim supporting span provided'),
    };
  }
  return entry;
}

/** Entry shape accepted by enforceNumericMatchRule: a full entry whose
 *  numeric_comparison may still be the loose input record (a fully-derived
 *  ClaimGroundingEntry is assignable to this, so the rule also runs on
 *  already-normalized entries). */
type NumericMatchRuleInput = Omit<ClaimGroundingEntry, 'numeric_comparison'> & {
  numeric_comparison?: ClaimNumericComparisonInputRecord;
};

/** Numeric-match anti-fakery invariant (mirror of enforceSpanRule; see the
 *  header comment for the full rule set). For method === 'numeric_match':
 *   - the recorded comparison's verdict/details are RECOMPUTED from its input
 *     (a supplied verdict is never trusted; a differing one is noted);
 *   - comparison `mismatch` forces a substantiated/partial grounding verdict
 *     down to `conflicting` (the computed comparison actively contradicts the
 *     asserted match);
 *   - comparison `incomparable` forces `substantiated` down to
 *     `not_substantiated` (an incomparable check cannot confirm anything;
 *     `partial` stays available for e.g. a source that discusses the quantity
 *     without a comparable value);
 *   - a substantiated/partial verdict with NO recorded comparison is downgraded
 *     to `not_substantiated` — a numeric match that was not computed does not
 *     exist.
 *  Downgrades only — this rule never upgrades a verdict (positive verdicts stay
 *  the agent's judgment; the machine only vetoes). Non-numeric_match entries
 *  pass through untouched: a stray numeric_comparison on them is a labeling
 *  error the validators reject loudly rather than silently strip. */
export function enforceNumericMatchRule(entry: NumericMatchRuleInput): ClaimGroundingEntry {
  if (entry.method !== 'numeric_match') {
    // Runtime-safe: if a loose record is attached here, validation rejects the
    // entry before it can leave assemble/parse (numeric_comparison is only
    // allowed for method 'numeric_match').
    return entry as ClaimGroundingEntry;
  }
  const record = entry.numeric_comparison;
  if (record === undefined) {
    if (entry.verdict === 'substantiated' || entry.verdict === 'partial') {
      return {
        ...(entry as ClaimGroundingEntry),
        verdict: 'not_substantiated',
        verification_status: verdictToVerificationStatus('not_substantiated'),
        notes: appendNote(
          entry.notes,
          "downgraded to not_substantiated: method is 'numeric_match' but no numeric_comparison was recorded",
        ),
      };
    }
    return entry as ClaimGroundingEntry;
  }
  const recomputed = compareNumericClaim(record.input);
  const recomputeNote =
    record.verdict !== undefined && record.verdict !== recomputed.verdict
      ? `numeric_comparison verdict recomputed from its input: supplied '${record.verdict}', computed '${recomputed.verdict}'`
      : undefined;
  const baseNotes = recomputeNote ? appendNote(entry.notes, recomputeNote) : entry.notes;
  const base: ClaimGroundingEntry = {
    ...entry,
    numeric_comparison: { input: record.input, verdict: recomputed.verdict, details: recomputed.details },
    ...(baseNotes !== undefined ? { notes: baseNotes } : {}),
  };
  if (recomputed.verdict === 'mismatch' && (base.verdict === 'substantiated' || base.verdict === 'partial')) {
    return {
      ...base,
      verdict: 'conflicting',
      verification_status: verdictToVerificationStatus('conflicting'),
      notes: appendNote(
        base.notes,
        'downgraded to conflicting: numeric comparison found a mismatch between the claimed value and the source value',
      ),
    };
  }
  if (recomputed.verdict === 'incomparable' && base.verdict === 'substantiated') {
    return {
      ...base,
      verdict: 'not_substantiated',
      verification_status: verdictToVerificationStatus('not_substantiated'),
      notes: appendNote(
        base.notes,
        `downgraded to not_substantiated: numeric comparison is incomparable (${recomputed.details.decision_path})`,
      ),
    };
  }
  return base;
}

function round4(value: number): number {
  return Math.round(value * 10000) / 10000;
}

export function groundingRiskScore(entries: Pick<ClaimGroundingEntry, 'verdict'>[]): number {
  if (entries.length === 0) return 0;
  const total = entries.reduce((sum, entry) => sum + RISK_WEIGHT[entry.verdict], 0);
  return round4(total / entries.length);
}

function tallyByVerdict(entries: Pick<ClaimGroundingEntry, 'verdict'>[]): Record<ClaimGroundingVerdict, number> {
  const counts = {
    substantiated: 0,
    partial: 0,
    not_substantiated: 0,
    conflicting: 0,
    source_unavailable: 0,
  } as Record<ClaimGroundingVerdict, number>;
  for (const entry of entries) counts[entry.verdict] += 1;
  return counts;
}

export type ClaimGroundingEntryInput = Omit<ClaimGroundingEntry, 'verification_status' | 'numeric_comparison'> & {
  verification_status?: ClaimVerificationStatus;
  numeric_comparison?: ClaimNumericComparisonInputRecord;
};

/** Build a validated report from per-claim entries.
 *  - verification_status is ALWAYS derived from verdict (any supplied value is ignored);
 *  - the numeric-match rule is enforced (comparison verdict recomputed from its
 *    input; mismatch/incomparable/missing-comparison downgrades applied);
 *  - the span rule is enforced (substantiated/partial without a span → not_substantiated);
 *  - summary counts + grounding_risk_score are computed from the final verdicts.
 *  Rule order matters: the numeric-match rule runs FIRST so a computed mismatch
 *  lands on `conflicting` even when the entry also lacks a span (an active
 *  contradiction outranks a missing quote); the span rule then still applies to
 *  whatever survives as substantiated/partial.
 *  Throws if the assembled report fails schema validation. */
export function assembleClaimGroundingReport(input: {
  generated_at: string;
  source_ref?: string;
  entries: ClaimGroundingEntryInput[];
}): ClaimGroundingReportV1 {
  const claims = input.entries.map(entry =>
    enforceSpanRule(
      enforceNumericMatchRule({ ...entry, verification_status: verdictToVerificationStatus(entry.verdict) }),
    ),
  );
  const report: ClaimGroundingReportV1 = {
    version: 1,
    generated_at: input.generated_at,
    ...(input.source_ref !== undefined ? { source_ref: input.source_ref } : {}),
    claims,
    summary: {
      total: claims.length,
      by_verdict: tallyByVerdict(claims),
      grounding_risk_score: groundingRiskScore(claims),
    },
  };
  const parsed = safeParseClaimGroundingReportV1(report);
  if (!parsed.ok) {
    throw new Error(
      `assembled claim_grounding_report failed validation: ${parsed.issues.map(i => `${i.path || '<root>'}: ${i.message}`).join('; ')}`,
    );
  }
  return parsed.value;
}

/** Shape of an idea-card-style claim that grounding writes back into. */
export type GroundableClaim = {
  claim_text: string;
  verification_status?: ClaimVerificationStatus;
  verification_notes?: string;
  [key: string]: unknown;
};

/** Pure write-back: return a new claims array with verification_status/notes set from
 *  the report (matched by claim_index). Other claim fields are preserved untouched, so
 *  the result stays valid against the idea-card schema (both fields are schema-allowed).
 *  Does no I/O — the caller decides whether to overwrite the source or emit a copy. */
export function applyGroundingToClaims<T extends GroundableClaim>(
  claims: T[],
  report: ClaimGroundingReportV1,
): T[] {
  const byIndex = new Map<number, ClaimGroundingEntry>();
  for (const entry of report.claims) byIndex.set(entry.claim_index, entry);
  return claims.map((claim, index) => {
    const entry = byIndex.get(index);
    if (!entry) return claim;
    const note = `claim-grounding: ${entry.verdict}${entry.notes ? ` (${entry.notes})` : ''}`;
    return {
      ...claim,
      verification_status: entry.verification_status,
      verification_notes: claim.verification_notes
        ? `${claim.verification_notes}; ${note}`
        : note,
    };
  });
}

// ─── Validation (hand-rolled, mirrors staged-content.ts) ───

export type ClaimGroundingParseIssue = { path: string; message: string };
type ParseSuccess = { ok: true; value: ClaimGroundingReportV1 };
type ParseFailure = { ok: false; issues: ClaimGroundingParseIssue[] };

function issue(path: string, message: string): ClaimGroundingParseIssue {
  return { path, message };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function validateSpan(span: unknown, path: string, issues: ClaimGroundingParseIssue[]): void {
  if (!isObject(span)) {
    issues.push(issue(path, 'must be an object'));
    return;
  }
  if (!isNonEmptyString(span.evidence_uri)) issues.push(issue(`${path}.evidence_uri`, 'must be a non-empty string'));
  if (typeof span.quote !== 'string') issues.push(issue(`${path}.quote`, 'must be a string'));
  if (span.locator !== undefined && typeof span.locator !== 'string') {
    issues.push(issue(`${path}.locator`, 'must be a string when provided'));
  }
}

function isFiniteNumberValue(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function validateToleranceShape(value: unknown, path: string, issues: ClaimGroundingParseIssue[]): boolean {
  if (!isObject(value)) {
    issues.push(issue(path, 'must be an object'));
    return false;
  }
  const kind = value.kind;
  if (kind === 'absolute' || kind === 'relative') {
    if (!isFiniteNumberValue(value.value)) {
      issues.push(issue(`${path}.value`, `must be a finite number for kind '${kind}'`));
      return false;
    }
    return true;
  }
  if (kind === 'uncertainty_multiple') {
    if (!isFiniteNumberValue(value.multiple)) {
      issues.push(issue(`${path}.multiple`, "must be a finite number for kind 'uncertainty_multiple'"));
      return false;
    }
    return true;
  }
  issues.push(issue(`${path}.kind`, `must be one of ${NUMERIC_TOLERANCE_KINDS.join(', ')}`));
  return false;
}

/** Structural validation of the comparison input as STORED in the report. Every
 *  numeric scalar must be FINITE: the report is a JSON artifact and NaN/Infinity
 *  do not survive JSON serialization (JSON.stringify turns them into null), so
 *  accepting them in-memory would break the round-trip invariant that a report
 *  which validates still validates after stringify/parse. A comparison whose
 *  input is not JSON-faithful must not be stored at all (compareNumericClaim
 *  still handles such values defensively for direct callers). Value-level
 *  semantics beyond finiteness (non-positive uncertainty, contradictory
 *  attestation, ...) stay owned by compareNumericClaim, whose recomputation the
 *  consistency check below compares against. Returns whether the shape is sound
 *  enough to recompute. */
function validateNumericComparisonInputShape(
  value: unknown,
  path: string,
  issues: ClaimGroundingParseIssue[],
): boolean {
  if (!isObject(value)) {
    issues.push(issue(path, 'must be an object'));
    return false;
  }
  let sound = true;
  for (const field of ['claimed_value', 'source_value'] as const) {
    if (!isFiniteNumberValue(value[field])) {
      issues.push(issue(`${path}.${field}`, 'must be a finite number (NaN/Infinity do not survive JSON)'));
      sound = false;
    }
  }
  for (const field of ['claimed_uncertainty', 'source_uncertainty'] as const) {
    if (value[field] !== undefined && !isFiniteNumberValue(value[field])) {
      issues.push(issue(`${path}.${field}`, 'must be a finite number when provided (omit the field when absent)'));
      sound = false;
    }
  }
  if (value.no_stated_uncertainty !== undefined && typeof value.no_stated_uncertainty !== 'boolean') {
    issues.push(issue(`${path}.no_stated_uncertainty`, 'must be a boolean when provided'));
    sound = false;
  }
  if (!validateToleranceShape(value.tolerance, `${path}.tolerance`, issues)) sound = false;
  return sound;
}

const NUMERIC_DETAIL_NUMBER_FIELDS = [
  'signed_difference',
  'absolute_difference',
  'relative_difference',
  'combined_uncertainty',
  'sigma_distance',
  'tolerance_used',
] as const;

function validateNumericComparison(value: unknown, path: string, issues: ClaimGroundingParseIssue[]): void {
  if (!isObject(value)) {
    issues.push(issue(path, 'must be an object'));
    return;
  }
  const inputSound = validateNumericComparisonInputShape(value.input, `${path}.input`, issues);
  if (!NUMERIC_COMPARISON_VERDICTS.includes(value.verdict as NumericComparisonVerdict)) {
    issues.push(issue(`${path}.verdict`, `must be one of ${NUMERIC_COMPARISON_VERDICTS.join(', ')}`));
  }
  const details = value.details;
  if (!isObject(details)) {
    issues.push(issue(`${path}.details`, 'must be an object'));
  } else {
    for (const field of NUMERIC_DETAIL_NUMBER_FIELDS) {
      const v = details[field];
      if (!(v === null || (typeof v === 'number' && Number.isFinite(v)))) {
        issues.push(issue(`${path}.details.${field}`, 'must be a finite number or null'));
      }
    }
    if (!NUMERIC_COMPARISON_DECISION_PATHS.includes(details.decision_path as NumericComparisonDecisionPath)) {
      issues.push(issue(`${path}.details.decision_path`, `must be one of ${NUMERIC_COMPARISON_DECISION_PATHS.join(', ')}`));
    }
    if (!isNonEmptyString(details.reason)) {
      issues.push(issue(`${path}.details.reason`, 'must be a non-empty string'));
    }
  }
  // Anti-fakery at the contract boundary: the recorded verdict/decision_path must
  // be reproducible from the recorded input (compareNumericClaim is pure, so the
  // recomputation is exact). The numeric detail fields are validated for type only
  // — cross-language JSON writers may re-serialize floats, and verdict +
  // decision_path are the load-bearing outcome.
  if (inputSound) {
    const recomputed = compareNumericClaim(value.input as NumericClaimComparisonInput);
    if (value.verdict !== recomputed.verdict) {
      issues.push(issue(
        `${path}.verdict`,
        `must equal the verdict recomputed from input ('${recomputed.verdict}')`,
      ));
    }
    if (isObject(details) && details.decision_path !== recomputed.details.decision_path) {
      issues.push(issue(
        `${path}.details.decision_path`,
        `must equal the decision path recomputed from input ('${recomputed.details.decision_path}')`,
      ));
    }
  }
}

function validateEntry(entry: unknown, path: string, issues: ClaimGroundingParseIssue[]): void {
  if (!isObject(entry)) {
    issues.push(issue(path, 'must be an object'));
    return;
  }
  if (typeof entry.claim_index !== 'number' || !Number.isInteger(entry.claim_index) || entry.claim_index < 0) {
    issues.push(issue(`${path}.claim_index`, 'must be a non-negative integer'));
  }
  if (!isNonEmptyString(entry.claim_text)) issues.push(issue(`${path}.claim_text`, 'must be a non-empty string'));
  if (!isNonEmptyString(entry.support_type)) issues.push(issue(`${path}.support_type`, 'must be a non-empty string'));
  if (!Array.isArray(entry.evidence_uris) || !entry.evidence_uris.every(u => typeof u === 'string')) {
    issues.push(issue(`${path}.evidence_uris`, 'must be an array of strings'));
  }
  if (!EVIDENCE_DOMAINS.includes(entry.domain as EvidenceDomain)) {
    issues.push(issue(`${path}.domain`, `must be one of ${EVIDENCE_DOMAINS.join(', ')}`));
  }
  if (!GROUNDING_METHODS.includes(entry.method as ClaimGroundingMethod)) {
    issues.push(issue(`${path}.method`, `must be one of ${GROUNDING_METHODS.join(', ')}`));
  }
  if (!CLAIM_GROUNDING_VERDICTS.includes(entry.verdict as ClaimGroundingVerdict)) {
    issues.push(issue(`${path}.verdict`, `must be one of ${CLAIM_GROUNDING_VERDICTS.join(', ')}`));
  }
  if (!Array.isArray(entry.supporting_spans)) {
    issues.push(issue(`${path}.supporting_spans`, 'must be an array'));
  } else {
    entry.supporting_spans.forEach((span, i) => validateSpan(span, `${path}.supporting_spans[${i}]`, issues));
  }
  if (!VERIFICATION_STATUSES.includes(entry.verification_status as ClaimVerificationStatus)) {
    issues.push(issue(`${path}.verification_status`, `must be one of ${VERIFICATION_STATUSES.join(', ')}`));
  } else if (
    CLAIM_GROUNDING_VERDICTS.includes(entry.verdict as ClaimGroundingVerdict)
    && entry.verification_status !== verdictToVerificationStatus(entry.verdict as ClaimGroundingVerdict)
  ) {
    // verification_status is DERIVED from verdict (single source of truth) —
    // reject a hand-edited status that the verdict does not reproduce, exactly
    // as assemble would have overwritten it.
    issues.push(issue(
      `${path}.verification_status`,
      `must equal the status derived from verdict ('${verdictToVerificationStatus(entry.verdict as ClaimGroundingVerdict)}')`,
    ));
  }
  // Re-assert the anti-fakery invariant at the contract boundary.
  if (
    (entry.verdict === 'substantiated' || entry.verdict === 'partial')
    && Array.isArray(entry.supporting_spans)
    && !hasVerbatimSpan(entry.supporting_spans)
  ) {
    issues.push(issue(`${path}.supporting_spans`, `must contain a verbatim span for verdict '${String(entry.verdict)}'`));
  }
  // Re-assert the numeric-match invariants at the contract boundary (parse-side
  // mirror of enforceNumericMatchRule — reject what assemble would have altered).
  if (entry.numeric_comparison !== undefined) {
    if (entry.method !== 'numeric_match') {
      issues.push(issue(`${path}.numeric_comparison`, "only allowed when method is 'numeric_match'"));
    }
    validateNumericComparison(entry.numeric_comparison, `${path}.numeric_comparison`, issues);
    if (isObject(entry.numeric_comparison)) {
      const comparisonVerdict = entry.numeric_comparison.verdict;
      if (comparisonVerdict === 'mismatch' && (entry.verdict === 'substantiated' || entry.verdict === 'partial')) {
        issues.push(issue(
          `${path}.verdict`,
          `must not be '${String(entry.verdict)}' when numeric_comparison.verdict is 'mismatch'`,
        ));
      }
      if (comparisonVerdict === 'incomparable' && entry.verdict === 'substantiated') {
        issues.push(issue(
          `${path}.verdict`,
          "must not be 'substantiated' when numeric_comparison.verdict is 'incomparable'",
        ));
      }
    }
  } else if (
    entry.method === 'numeric_match'
    && (entry.verdict === 'substantiated' || entry.verdict === 'partial')
  ) {
    issues.push(issue(
      `${path}.numeric_comparison`,
      `required when method is 'numeric_match' and verdict is '${String(entry.verdict)}'`,
    ));
  }
  if (entry.notes !== undefined && typeof entry.notes !== 'string') {
    issues.push(issue(`${path}.notes`, 'must be a string when provided'));
  }
}

export function safeParseClaimGroundingReportV1(value: unknown): ParseSuccess | ParseFailure {
  const issues: ClaimGroundingParseIssue[] = [];
  if (!isObject(value)) {
    return { ok: false, issues: [issue('', 'must be a JSON object')] };
  }
  if (value.version !== 1) issues.push(issue('version', 'must equal 1'));
  if (!isNonEmptyString(value.generated_at)) issues.push(issue('generated_at', 'must be a non-empty string'));
  if (value.source_ref !== undefined && typeof value.source_ref !== 'string') {
    issues.push(issue('source_ref', 'must be a string when provided'));
  }
  if (!Array.isArray(value.claims)) {
    issues.push(issue('claims', 'must be an array'));
  } else {
    value.claims.forEach((entry, i) => validateEntry(entry, `claims[${i}]`, issues));
  }
  const summary = value.summary;
  if (!isObject(summary)) {
    issues.push(issue('summary', 'must be an object'));
  } else {
    if (typeof summary.total !== 'number' || !Number.isInteger(summary.total) || summary.total < 0) {
      issues.push(issue('summary.total', 'must be a non-negative integer'));
    }
    if (!isObject(summary.by_verdict)) {
      issues.push(issue('summary.by_verdict', 'must be an object'));
    } else {
      for (const verdict of CLAIM_GROUNDING_VERDICTS) {
        if (typeof summary.by_verdict[verdict] !== 'number') {
          issues.push(issue(`summary.by_verdict.${verdict}`, 'must be a number'));
        }
      }
    }
    if (
      typeof summary.grounding_risk_score !== 'number'
      || summary.grounding_risk_score < 0
      || summary.grounding_risk_score > 1
    ) {
      issues.push(issue('summary.grounding_risk_score', 'must be a number in [0, 1]'));
    }
    // Summary is DERIVED from the claims — reject a tampered tally/score exactly
    // as assemble would have recomputed it. Only checked when every entry verdict
    // is structurally valid (otherwise the recomputation is undefined and the
    // per-entry issues already reject the report). The risk score allows a 1e-6
    // slack — generous against honest cross-language double representation of the
    // same 4-decimal value (that differs at the ULP scale, ~1e-16) while far below
    // the 1e-4 rounding step, so a tamper of one rounding step is detected. An
    // implementation whose HALF-rounding mode disagrees at an exact .5 boundary is
    // an implementation-semantics mismatch to fix there, not slack to absorb here
    // (a slack as wide as the effect it must catch would itself be non-diagnostic).
    if (
      Array.isArray(value.claims)
      && value.claims.every(entry =>
        isObject(entry) && CLAIM_GROUNDING_VERDICTS.includes(entry.verdict as ClaimGroundingVerdict))
    ) {
      const entries = value.claims.map(entry => ({
        verdict: (entry as Record<string, unknown>).verdict as ClaimGroundingVerdict,
      }));
      if (typeof summary.total === 'number' && summary.total !== entries.length) {
        issues.push(issue('summary.total', `must equal the number of claims (${entries.length})`));
      }
      if (isObject(summary.by_verdict)) {
        const tally = tallyByVerdict(entries);
        for (const verdict of CLAIM_GROUNDING_VERDICTS) {
          if (
            typeof summary.by_verdict[verdict] === 'number'
            && summary.by_verdict[verdict] !== tally[verdict]
          ) {
            issues.push(issue(
              `summary.by_verdict.${verdict}`,
              `must equal the count derived from claims (${tally[verdict]})`,
            ));
          }
        }
      }
      if (typeof summary.grounding_risk_score === 'number') {
        const recomputedRisk = groundingRiskScore(entries);
        if (Math.abs(summary.grounding_risk_score - recomputedRisk) > 1e-6) {
          issues.push(issue(
            'summary.grounding_risk_score',
            `must equal the score derived from claims (${recomputedRisk})`,
          ));
        }
      }
    }
  }
  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, value: value as unknown as ClaimGroundingReportV1 };
}

export function parseClaimGroundingReportV1(value: unknown): ClaimGroundingReportV1 {
  const parsed = safeParseClaimGroundingReportV1(value);
  if (parsed.ok) return parsed.value;
  throw new Error(parsed.issues.map(entry => `${entry.path || '<root>'}: ${entry.message}`).join('; '));
}
