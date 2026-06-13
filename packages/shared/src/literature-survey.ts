// Literature-survey contract (deep literature review capability).
//
// A `literature_survey_v1` is the structured synthesis/coverage layer over a deep
// literature review. The rich per-paper notes themselves stay as research-team KB
// note Markdown files (the existing template, deep-read-filled); this artifact
// INDEXES them and carries the cross-paper synthesis (consensus / tensions / gaps)
// plus a coverage block — so "how deep / how complete was the survey" is checkable,
// not just asserted in prose.
//
// Two integrity invariants (assembleLiteratureSurvey + the parser), the analog of
// claim-grounding's span rule:
//   1. Coverage counts are COMPUTED from `papers`, never trusted from the caller —
//      you cannot claim "20 deep-read" when only 3 papers carry read_status:deep_read.
//   2. Referential integrity: every ref_key cited in synthesis (consensus/tensions)
//      MUST exist in `papers` — the synthesis cannot cite papers the survey never read.
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

export type LiteratureSurveyCoverage = {
  total_papers: number;
  deep_read: number;
  core_total: number;
  core_deep_read: number;
  /** v1: discipline-asserted (the recipes drive multi-hop search; active saturation
   *  measurement is a fast-follow). 'unknown' when the caller does not assert it. */
  saturation: SaturationStatus;
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

/** Coverage is DERIVED from papers — never trusted from the caller. */
export function computeSurveyCoverage(
  papers: SurveyPaper[],
  saturation: SaturationStatus = 'unknown',
  notes?: string,
): LiteratureSurveyCoverage {
  // Defensive: also called from assemble before the parser runs, and reachable with raw
  // (cast-in) input — filter to objects so a null/non-object element cannot crash here.
  const list = (Array.isArray(papers) ? papers : []).filter(isObject);
  const core = list.filter(p => p.role === 'core');
  return {
    total_papers: list.length,
    deep_read: list.filter(p => p.read_status === 'deep_read').length,
    core_total: core.length,
    core_deep_read: core.filter(p => p.read_status === 'deep_read').length,
    saturation,
    ...(notes !== undefined ? { notes } : {}),
  };
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
  coverage_notes?: string;
};

/** Build a validated survey: coverage is recomputed from papers, referential integrity
 *  is enforced, then the result is schema-validated. Throws on violation. */
export function assembleLiteratureSurvey(input: AssembleLiteratureSurveyInput): LiteratureSurveyV1 {
  const survey: LiteratureSurveyV1 = {
    version: 1,
    generated_at: input.generated_at,
    topic: input.topic,
    ...(input.scope_ref !== undefined ? { scope_ref: input.scope_ref } : {}),
    papers: input.papers,
    synthesis: input.synthesis,
    coverage: computeSurveyCoverage(input.papers, input.saturation ?? 'unknown', input.coverage_notes),
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
