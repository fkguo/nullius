// Literature-survey contract (deep literature review capability).
//
// A `literature_survey_v1` is the structured synthesis/coverage layer over a deep
// literature review. The rich per-paper notes themselves stay as research-team KB
// note Markdown files (the existing template, deep-read-filled); this artifact
// INDEXES them and carries the cross-paper synthesis (consensus / tensions / gaps)
// plus a coverage block — so "how deep / how complete was the survey" is checkable,
// not just asserted in prose.
//
// Three integrity invariants (assembleLiteratureSurvey + the parser), the analog of
// claim-grounding's span rule:
//   1. Coverage counts are COMPUTED from `papers`, never trusted from the caller —
//      you cannot claim "20 deep-read" when only 3 papers carry read_status:deep_read.
//   2. Referential integrity: every ref_key cited in synthesis (consensus/tensions)
//      MUST exist in `papers` — the synthesis cannot cite papers the survey never read.
//   3. Saturation is EVIDENCE-BACKED, never merely asserted: a `saturated` status must
//      be supported by recorded expansion-round measurements
//      (coverage.saturation_evidence) whose terminal round screened candidates yet
//      admitted zero new core papers. An unsupported `saturated` is mechanically
//      downgraded to coverage_incomplete at assemble time (reason appended to
//      coverage.notes) and rejected at the parse boundary (reason in issues) —
//      mirroring claim-grounding's enforceSpanRule: visible downgrade, never a
//      silently accepted claim.
//
// Style mirrors staged-content.ts / claim-grounding.ts: locally-defined types + a
// hand-rolled safeParse/parse (no zod).

import type { PaperIdentifiers } from './types/identifiers.js';

export type SurveyDomain = 'hep' | 'general';
export type PaperReadStatus = 'deep_read' | 'metadata_only' | 'unavailable';
export type PaperRole = 'core' | 'supporting' | 'background';
export type SaturationStatus = 'saturated' | 'coverage_incomplete' | 'unknown';
export type SynthesisTensionKind = 'measurement' | 'theoretical' | 'methodological' | 'other';

export type SurveyPaper = {
  /** Join key — the research-team KB note RefKey. */
  ref_key: string;
  title?: string;
  /** Path to the rich (deep-read-filled) KB note .md. */
  note_path?: string;
  identifiers?: PaperIdentifiers;
  domain: SurveyDomain;
  read_status: PaperReadStatus;
  role: PaperRole;
  /** One-line synthesized contribution of this paper to the survey. */
  one_line: string;
};

export type SurveyConsensus = { statement: string; supporting_ref_keys: string[] };
export type SurveyTension = { statement: string; ref_keys: string[]; kind?: SynthesisTensionKind };

export type LiteratureSurveySynthesis = {
  consensus: SurveyConsensus[];
  tensions: SurveyTension[];
  /** Open questions / coverage gaps surfaced by the survey. */
  gaps: string[];
  /** Optional inline narrative landscape (kept short; the full prose lives in notes). */
  landscape_md?: string;
};

/** One recorded round of core-set expansion: screening the references + citations
 *  (the frontier) of the core set as it stood at the start of the round.
 *  Domain-agnostic — a "round" is a unit of the survey's own discovery process,
 *  not of any particular discipline or provider. */
export type SaturationExpansionRound = {
  /** 1-based ordinal. Rounds must be contiguous (1, 2, 3, …) so the array is the
   *  COMPLETE round history: omitting an intermediate round is a schema error, which
   *  keeps the log auditable and makes silent gaps impossible by construction. */
  round: number;
  /** Expansion candidates actually examined and dispositioned this round — kept in
   *  any role, rejected as off-topic, or discarded as already-known duplicates. This
   *  measures screening WORK, so a round that did nothing cannot be dressed up as a
   *  converged round (see assessSaturationEvidence). */
  expansion_candidates_screened: number;
  /** Papers this round's screening added to the survey's FINAL core set. Stated in
   *  final-membership terms: a paper admitted here but later demoted out of `core`
   *  does not count, and each core paper is credited to at most one round — which is
   *  what makes the cross-check against coverage.core_total sound (see
   *  validateCoverage). */
  new_core_papers: number;
};

export type LiteratureSurveyCoverage = {
  total_papers: number;
  deep_read: number;
  core_total: number;
  core_deep_read: number;
  /** Machine-checked against saturation_evidence: `saturated` is legal only when the
   *  recorded rounds support it (assessSaturationEvidence). 'coverage_incomplete' is
   *  explicit declared debt; 'unknown' when the producer does not assert saturation. */
  saturation: SaturationStatus;
  /** Expansion-round measurements backing the saturation status. REQUIRED to support
   *  `saturated` (non-empty; terminal round with expansion_candidates_screened > 0 and
   *  new_core_papers = 0); optional for other statuses, but always schema-validated
   *  when present. */
  saturation_evidence?: SaturationExpansionRound[];
  notes?: string;
};

export type LiteratureSurveyV1 = {
  version: 1;
  generated_at: string;
  /** The survey question / topic. */
  topic: string;
  /** Where the survey was scoped from (project / run / question ref). */
  scope_ref?: string;
  papers: SurveyPaper[];
  synthesis: LiteratureSurveySynthesis;
  coverage: LiteratureSurveyCoverage;
};

const SURVEY_DOMAINS: readonly SurveyDomain[] = ['hep', 'general'];
const READ_STATUSES: readonly PaperReadStatus[] = ['deep_read', 'metadata_only', 'unavailable'];
const PAPER_ROLES: readonly PaperRole[] = ['core', 'supporting', 'background'];
const SATURATION_STATUSES: readonly SaturationStatus[] = ['saturated', 'coverage_incomplete', 'unknown'];
const TENSION_KINDS: readonly SynthesisTensionKind[] = ['measurement', 'theoretical', 'methodological', 'other'];

// ─── Pure helpers ───

/** Structural validation of a saturation_evidence value, shared verbatim by the
 *  parse boundary (validateCoverage) and the business rule (assessSaturationEvidence)
 *  so the two sides cannot drift. Paths are relative to `saturation_evidence`.
 *  Defensive: runs on raw parsed JSON — guard every dereference. */
function saturationEvidenceIssues(evidence: unknown): LiteratureSurveyParseIssue[] {
  if (!Array.isArray(evidence)) {
    return [issue('saturation_evidence', 'must be an array when provided')];
  }
  const issues: LiteratureSurveyParseIssue[] = [];
  evidence.forEach((entry, i) => {
    const path = `saturation_evidence[${i}]`;
    if (!isObject(entry)) {
      issues.push(issue(path, 'must be an object'));
      return;
    }
    for (const field of ['round', 'expansion_candidates_screened', 'new_core_papers'] as const) {
      if (!isNonNegativeInteger(entry[field])) {
        issues.push(issue(`${path}.${field}`, 'must be a non-negative integer'));
      }
    }
    // Rounds are the complete, ordered history: 1-based and contiguous. Ordinal
    // contiguity subsumes strictly-increasing ordinals and makes an omitted
    // intermediate round a schema error. (Only the ROUND ordinals are constrained —
    // screened/admitted counts may rise and fall freely as the frontier changes.)
    if (isNonNegativeInteger(entry.round) && entry.round !== i + 1) {
      issues.push(issue(`${path}.round`, `must equal ${i + 1} (rounds are 1-based and contiguous)`));
    }
    // A round cannot admit more core papers than the candidates it screened.
    if (
      isNonNegativeInteger(entry.new_core_papers)
      && isNonNegativeInteger(entry.expansion_candidates_screened)
      && entry.new_core_papers > entry.expansion_candidates_screened
    ) {
      issues.push(issue(`${path}.new_core_papers`, 'cannot exceed expansion_candidates_screened for the same round'));
    }
  });
  return issues;
}

/** Total core-paper admissions the rounds claim (malformed entries contribute 0 —
 *  callers surface those through saturationEvidenceIssues instead). */
function sumNewCorePapers(evidence: unknown): number {
  if (!Array.isArray(evidence)) return 0;
  return evidence
    .filter(isObject)
    .reduce((sum, r) => sum + (isNonNegativeInteger(r.new_core_papers) ? r.new_core_papers : 0), 0);
}

export type SaturationEvidenceAssessment =
  | { supported: true }
  | { supported: false; reason: string };

/** Mechanical saturation rule (pure, the single source of truth for both sides):
 *  a `saturated` status is supported iff the recorded rounds are well-formed,
 *  consistent with the survey's core count (when `coreTotal` context is supplied,
 *  total admissions must not exceed it), and the TERMINAL round did real screening
 *  work (expansion_candidates_screened > 0) yet admitted zero new core papers — i.e.
 *  the core set is a fixed point of one full reference+citation expansion. The
 *  screened > 0 requirement blocks the zero-work/zero-finding fake: a round that
 *  examined nothing has demonstrated nothing.
 *
 *  Why the terminal round alone (K = 1): each round screens the frontier of the core
 *  set as it stands at the start of the round. A terminal round that screened
 *  candidates and admitted no new core paper leaves the core set unchanged, so its
 *  frontier has just been screened — a further round could only re-screen the same
 *  frontier. Requiring a second consecutive zero round would force a provably
 *  redundant no-op (or tempt producers to fabricate one) without adding evidential
 *  value. What K = 1 cannot certify — that the round really screened the FULL
 *  frontier — no K can certify either; that honesty obligation lives in the
 *  deep-literature-review measurement discipline, not in this rule.
 *
 *  The rule only FALSIFIES `saturated`; it never upgrades a weaker status. Evidence
 *  consistent with saturation does not prove the frontier enumeration was complete,
 *  so asserting `saturated` stays a deliberate act of the producer. */
export function assessSaturationEvidence(evidence: unknown, coreTotal?: number): SaturationEvidenceAssessment {
  if (evidence === undefined || (Array.isArray(evidence) && evidence.length === 0)) {
    return { supported: false, reason: 'no expansion-round evidence recorded (saturation must be measured, not asserted)' };
  }
  const problems = saturationEvidenceIssues(evidence);
  if (problems.length > 0) {
    return {
      supported: false,
      reason: `expansion-round evidence is malformed: ${problems.map(p => `${p.path}: ${p.message}`).join('; ')}`,
    };
  }
  if (isNonNegativeInteger(coreTotal)) {
    const admitted = sumNewCorePapers(evidence);
    if (admitted > coreTotal) {
      return {
        supported: false,
        reason: `rounds admit ${admitted} core papers in total but the survey carries only ${coreTotal} — the evidence is inconsistent with the artifact`,
      };
    }
  }
  const rounds = evidence as SaturationExpansionRound[];
  const last = rounds[rounds.length - 1]!;
  if (last.new_core_papers > 0) {
    return {
      supported: false,
      reason: `last expansion round (round ${last.round}) still yielded ${last.new_core_papers} new core paper(s) — expansion has not converged`,
    };
  }
  if (last.expansion_candidates_screened === 0) {
    return {
      supported: false,
      reason: `last expansion round (round ${last.round}) screened zero candidates — a zero-work round demonstrates nothing`,
    };
  }
  return { supported: true };
}

/** Anti-fakery invariant (the saturation analog of claim-grounding's enforceSpanRule):
 *  a `saturated` status not supported by the recorded expansion rounds — including
 *  rounds whose total admissions exceed the coverage's own core_total — is downgraded
 *  to coverage_incomplete, with the reason appended to notes so the downgrade is
 *  visible in the artifact — never a silent value change. */
export function enforceSaturationRule(coverage: LiteratureSurveyCoverage): LiteratureSurveyCoverage {
  if (coverage.saturation !== 'saturated') return coverage;
  const assessment = assessSaturationEvidence(
    coverage.saturation_evidence,
    isNonNegativeInteger(coverage.core_total) ? coverage.core_total : undefined,
  );
  if (assessment.supported) return coverage;
  return {
    ...coverage,
    saturation: 'coverage_incomplete',
    notes: appendNote(coverage.notes, `downgraded to coverage_incomplete: ${assessment.reason}`),
  };
}

export type SurveyCoverageOptions = {
  saturation?: SaturationStatus;
  saturation_evidence?: SaturationExpansionRound[];
  notes?: string;
};

/** Coverage is DERIVED from papers — never trusted from the caller — and the full
 *  saturation rule (structure + admissions-vs-core_total reconciliation + terminal
 *  convergence) is enforced on the way out, so no compute path — including direct
 *  standalone calls — can emit an unsupported `saturated`. */
export function computeSurveyCoverage(
  papers: SurveyPaper[],
  options: SurveyCoverageOptions = {},
): LiteratureSurveyCoverage {
  // Defensive: also called from assemble before the parser runs, and reachable with raw
  // (cast-in) input — filter to objects so a null/non-object element cannot crash here.
  const list = (Array.isArray(papers) ? papers : []).filter(isObject);
  const core = list.filter(p => p.role === 'core');
  return enforceSaturationRule({
    total_papers: list.length,
    deep_read: list.filter(p => p.read_status === 'deep_read').length,
    core_total: core.length,
    core_deep_read: core.filter(p => p.read_status === 'deep_read').length,
    saturation: options.saturation ?? 'unknown',
    ...(options.saturation_evidence !== undefined ? { saturation_evidence: options.saturation_evidence } : {}),
    ...(options.notes !== undefined ? { notes: options.notes } : {}),
  });
}

/** ref_keys cited by synthesis that do NOT appear in papers (referential-integrity violations).
 *  Defensive: also runs on raw parsed JSON at the contract boundary, where papers/ref
 *  arrays may contain null/non-object/non-string elements — guard before dereferencing. */
export function danglingSynthesisRefs(survey: Pick<LiteratureSurveyV1, 'papers' | 'synthesis'>): string[] {
  const known = new Set<string>();
  const papers: unknown[] = Array.isArray(survey.papers) ? survey.papers : [];
  for (const p of papers) if (isObject(p) && typeof p.ref_key === 'string') known.add(p.ref_key);
  const cited = new Set<string>();
  const collect = (keys: unknown): void => {
    if (Array.isArray(keys)) for (const k of keys) if (typeof k === 'string') cited.add(k);
  };
  const synthesis = (survey.synthesis ?? {}) as Record<string, unknown>;
  const consensus: unknown[] = Array.isArray(synthesis.consensus) ? synthesis.consensus : [];
  const tensions: unknown[] = Array.isArray(synthesis.tensions) ? synthesis.tensions : [];
  for (const c of consensus) if (isObject(c)) collect(c.supporting_ref_keys);
  for (const t of tensions) if (isObject(t)) collect(t.ref_keys);
  return [...cited].filter(k => !known.has(k));
}

export type AssembleLiteratureSurveyInput = {
  generated_at: string;
  topic: string;
  scope_ref?: string;
  papers: SurveyPaper[];
  synthesis: LiteratureSurveySynthesis;
  saturation?: SaturationStatus;
  saturation_evidence?: SaturationExpansionRound[];
  coverage_notes?: string;
};

/** Build a validated survey: coverage is recomputed from papers, an unsupported
 *  `saturated` is downgraded (enforceSaturationRule, visible in coverage.notes),
 *  referential integrity is enforced, then the result is schema-validated. Throws on
 *  violation — including structurally malformed saturation_evidence, which is data
 *  corruption to reject loudly, not a claim to downgrade. */
export function assembleLiteratureSurvey(input: AssembleLiteratureSurveyInput): LiteratureSurveyV1 {
  const survey: LiteratureSurveyV1 = {
    version: 1,
    generated_at: input.generated_at,
    topic: input.topic,
    ...(input.scope_ref !== undefined ? { scope_ref: input.scope_ref } : {}),
    papers: input.papers,
    synthesis: input.synthesis,
    coverage: computeSurveyCoverage(input.papers, {
      saturation: input.saturation ?? 'unknown',
      ...(input.saturation_evidence !== undefined ? { saturation_evidence: input.saturation_evidence } : {}),
      ...(input.coverage_notes !== undefined ? { notes: input.coverage_notes } : {}),
    }),
  };
  const dangling = danglingSynthesisRefs(survey);
  if (dangling.length > 0) {
    throw new Error(
      `literature_survey synthesis cites ref_keys absent from papers: ${dangling.join(', ')}`,
    );
  }
  const parsed = safeParseLiteratureSurveyV1(survey);
  if (!parsed.ok) {
    throw new Error(
      `assembled literature_survey failed validation: ${parsed.issues.map(i => `${i.path || '<root>'}: ${i.message}`).join('; ')}`,
    );
  }
  return parsed.value;
}

// ─── Validation (hand-rolled, mirrors staged-content.ts / claim-grounding.ts) ───

export type LiteratureSurveyParseIssue = { path: string; message: string };
type ParseSuccess = { ok: true; value: LiteratureSurveyV1 };
type ParseFailure = { ok: false; issues: LiteratureSurveyParseIssue[] };

function issue(path: string, message: string): LiteratureSurveyParseIssue {
  return { path, message };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function appendNote(existing: string | undefined, addition: string): string {
  return existing && existing.trim().length > 0 ? `${existing}; ${addition}` : addition;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(v => typeof v === 'string');
}

function validatePaper(paper: unknown, path: string, issues: LiteratureSurveyParseIssue[]): void {
  if (!isObject(paper)) {
    issues.push(issue(path, 'must be an object'));
    return;
  }
  if (!isNonEmptyString(paper.ref_key)) issues.push(issue(`${path}.ref_key`, 'must be a non-empty string'));
  if (paper.title !== undefined && typeof paper.title !== 'string') issues.push(issue(`${path}.title`, 'must be a string when provided'));
  if (paper.note_path !== undefined && typeof paper.note_path !== 'string') issues.push(issue(`${path}.note_path`, 'must be a string when provided'));
  if (paper.identifiers !== undefined && !isObject(paper.identifiers)) issues.push(issue(`${path}.identifiers`, 'must be an object when provided'));
  if (!SURVEY_DOMAINS.includes(paper.domain as SurveyDomain)) issues.push(issue(`${path}.domain`, `must be one of ${SURVEY_DOMAINS.join(', ')}`));
  if (!READ_STATUSES.includes(paper.read_status as PaperReadStatus)) issues.push(issue(`${path}.read_status`, `must be one of ${READ_STATUSES.join(', ')}`));
  if (!PAPER_ROLES.includes(paper.role as PaperRole)) issues.push(issue(`${path}.role`, `must be one of ${PAPER_ROLES.join(', ')}`));
  if (!isNonEmptyString(paper.one_line)) issues.push(issue(`${path}.one_line`, 'must be a non-empty string'));
}

function validateConsensus(item: unknown, path: string, issues: LiteratureSurveyParseIssue[]): void {
  if (!isObject(item)) {
    issues.push(issue(path, 'must be an object'));
    return;
  }
  if (!isNonEmptyString(item.statement)) issues.push(issue(`${path}.statement`, 'must be a non-empty string'));
  if (!isStringArray(item.supporting_ref_keys)) issues.push(issue(`${path}.supporting_ref_keys`, 'must be an array of strings'));
}

function validateTension(item: unknown, path: string, issues: LiteratureSurveyParseIssue[]): void {
  if (!isObject(item)) {
    issues.push(issue(path, 'must be an object'));
    return;
  }
  if (!isNonEmptyString(item.statement)) issues.push(issue(`${path}.statement`, 'must be a non-empty string'));
  if (!isStringArray(item.ref_keys)) issues.push(issue(`${path}.ref_keys`, 'must be an array of strings'));
  if (item.kind !== undefined && !TENSION_KINDS.includes(item.kind as SynthesisTensionKind)) {
    issues.push(issue(`${path}.kind`, `must be one of ${TENSION_KINDS.join(', ')} when provided`));
  }
}

function validateSynthesis(synthesis: unknown, issues: LiteratureSurveyParseIssue[]): void {
  if (!isObject(synthesis)) {
    issues.push(issue('synthesis', 'must be an object'));
    return;
  }
  if (!Array.isArray(synthesis.consensus)) {
    issues.push(issue('synthesis.consensus', 'must be an array'));
  } else {
    synthesis.consensus.forEach((c, i) => validateConsensus(c, `synthesis.consensus[${i}]`, issues));
  }
  if (!Array.isArray(synthesis.tensions)) {
    issues.push(issue('synthesis.tensions', 'must be an array'));
  } else {
    synthesis.tensions.forEach((t, i) => validateTension(t, `synthesis.tensions[${i}]`, issues));
  }
  if (!isStringArray(synthesis.gaps)) issues.push(issue('synthesis.gaps', 'must be an array of strings'));
  if (synthesis.landscape_md !== undefined && typeof synthesis.landscape_md !== 'string') {
    issues.push(issue('synthesis.landscape_md', 'must be a string when provided'));
  }
}

function validateCoverage(coverage: unknown, issues: LiteratureSurveyParseIssue[]): void {
  if (!isObject(coverage)) {
    issues.push(issue('coverage', 'must be an object'));
    return;
  }
  for (const field of ['total_papers', 'deep_read', 'core_total', 'core_deep_read'] as const) {
    if (typeof coverage[field] !== 'number' || !Number.isInteger(coverage[field]) || (coverage[field] as number) < 0) {
      issues.push(issue(`coverage.${field}`, 'must be a non-negative integer'));
    }
  }
  if (!SATURATION_STATUSES.includes(coverage.saturation as SaturationStatus)) {
    issues.push(issue('coverage.saturation', `must be one of ${SATURATION_STATUSES.join(', ')}`));
  }
  if (coverage.saturation_evidence !== undefined) {
    for (const p of saturationEvidenceIssues(coverage.saturation_evidence)) {
      issues.push(issue(`coverage.${p.path}`, p.message));
    }
    // Reconciliation with the survey's core set. Full equality against core_total is
    // deliberately NOT required: seed-stage discovery (before any expansion round)
    // legitimately contributes core papers that no round admitted, and the rounds
    // carry counts, not per-round ref_key membership (papers[] stays the single
    // membership authority; duplicating it per round would bloat the artifact without
    // making fabrication harder). What IS sound — given that new_core_papers is stated
    // in final-membership terms with each core paper credited to at most one round —
    // is the upper bound: the rounds cannot claim to have admitted more core papers
    // than the survey contains.
    if (Array.isArray(coverage.saturation_evidence) && isNonNegativeInteger(coverage.core_total)) {
      const admitted = sumNewCorePapers(coverage.saturation_evidence);
      if (admitted > coverage.core_total) {
        issues.push(issue(
          'coverage.saturation_evidence',
          `rounds admit ${admitted} core papers in total, exceeding core_total (${coverage.core_total})`,
        ));
      }
    }
  }
  // Parse-boundary side of the saturation rule (assemble downgrades; the parser
  // REJECTS, mirroring how the claim-grounding parser re-asserts the span rule): a
  // hand-authored survey cannot circulate an unsupported `saturated`.
  if (coverage.saturation === 'saturated') {
    const assessment = assessSaturationEvidence(
      coverage.saturation_evidence,
      isNonNegativeInteger(coverage.core_total) ? coverage.core_total : undefined,
    );
    if (!assessment.supported) {
      issues.push(issue(
        'coverage.saturation',
        `claims 'saturated' unsupported by saturation_evidence: ${assessment.reason} (assembleLiteratureSurvey downgrades this to coverage_incomplete)`,
      ));
    }
  }
  if (coverage.notes !== undefined && typeof coverage.notes !== 'string') {
    issues.push(issue('coverage.notes', 'must be a string when provided'));
  }
}

export function safeParseLiteratureSurveyV1(value: unknown): ParseSuccess | ParseFailure {
  const issues: LiteratureSurveyParseIssue[] = [];
  if (!isObject(value)) {
    return { ok: false, issues: [issue('', 'must be a JSON object')] };
  }
  if (value.version !== 1) issues.push(issue('version', 'must equal 1'));
  if (!isNonEmptyString(value.generated_at)) issues.push(issue('generated_at', 'must be a non-empty string'));
  if (!isNonEmptyString(value.topic)) issues.push(issue('topic', 'must be a non-empty string'));
  if (value.scope_ref !== undefined && typeof value.scope_ref !== 'string') {
    issues.push(issue('scope_ref', 'must be a string when provided'));
  }
  if (!Array.isArray(value.papers)) {
    issues.push(issue('papers', 'must be an array'));
  } else {
    value.papers.forEach((p, i) => validatePaper(p, `papers[${i}]`, issues));
  }
  validateSynthesis(value.synthesis, issues);
  validateCoverage(value.coverage, issues);

  // Referential integrity: synthesis may only cite papers in the survey.
  if (
    Array.isArray(value.papers)
    && isObject(value.synthesis)
    && Array.isArray((value.synthesis as Record<string, unknown>).consensus)
    && Array.isArray((value.synthesis as Record<string, unknown>).tensions)
  ) {
    const dangling = danglingSynthesisRefs(value as unknown as LiteratureSurveyV1);
    if (dangling.length > 0) {
      issues.push(issue('synthesis', `cites ref_keys absent from papers: ${dangling.join(', ')}`));
    }
  }

  // Coverage integrity at the boundary: counts must match the papers (depth is not
  // free-text — the same guarantee assembleLiteratureSurvey enforces, re-asserted here so
  // a hand-authored survey cannot claim more depth than its papers carry).
  if (Array.isArray(value.papers) && isObject(value.coverage)) {
    const expected = computeSurveyCoverage(value.papers as SurveyPaper[]);
    for (const field of ['total_papers', 'deep_read', 'core_total', 'core_deep_read'] as const) {
      if (typeof value.coverage[field] === 'number' && value.coverage[field] !== expected[field]) {
        issues.push(issue(`coverage.${field}`, `must equal the count derived from papers (${expected[field]})`));
      }
    }
  }

  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, value: value as unknown as LiteratureSurveyV1 };
}

export function parseLiteratureSurveyV1(value: unknown): LiteratureSurveyV1 {
  const parsed = safeParseLiteratureSurveyV1(value);
  if (parsed.ok) return parsed.value;
  throw new Error(parsed.issues.map(entry => `${entry.path || '<root>'}: ${entry.message}`).join('; '));
}
