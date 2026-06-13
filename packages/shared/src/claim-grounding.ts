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
// Style mirrors staged-content.ts: locally-defined types + a hand-rolled
// safeParse/parse (no zod) — the same runtime-parser shape used across the shared
// *-bridge / verification-lift modules.

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

export type ClaimGroundingEntryInput = Omit<ClaimGroundingEntry, 'verification_status'> & {
  verification_status?: ClaimVerificationStatus;
};

/** Build a validated report from per-claim entries.
 *  - verification_status is ALWAYS derived from verdict (any supplied value is ignored);
 *  - the span rule is enforced (substantiated/partial without a span → not_substantiated);
 *  - summary counts + grounding_risk_score are computed from the final verdicts.
 *  Throws if the assembled report fails schema validation. */
export function assembleClaimGroundingReport(input: {
  generated_at: string;
  source_ref?: string;
  entries: ClaimGroundingEntryInput[];
}): ClaimGroundingReportV1 {
  const claims = input.entries.map(entry =>
    enforceSpanRule({ ...entry, verification_status: verdictToVerificationStatus(entry.verdict) }),
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
  }
  // Re-assert the anti-fakery invariant at the contract boundary.
  if (
    (entry.verdict === 'substantiated' || entry.verdict === 'partial')
    && Array.isArray(entry.supporting_spans)
    && !hasVerbatimSpan(entry.supporting_spans)
  ) {
    issues.push(issue(`${path}.supporting_spans`, `must contain a verbatim span for verdict '${String(entry.verdict)}'`));
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
  }
  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, value: value as unknown as ClaimGroundingReportV1 };
}

export function parseClaimGroundingReportV1(value: unknown): ClaimGroundingReportV1 {
  const parsed = safeParseClaimGroundingReportV1(value);
  if (parsed.ok) return parsed.value;
  throw new Error(parsed.issues.map(entry => `${entry.path || '<root>'}: ${entry.message}`).join('; '));
}
