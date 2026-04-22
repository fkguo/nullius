import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  compareWithBaseline,
  loadBaseline,
  runEvalSet,
  saveBaseline,
  type EvalResult,
} from '../../src/eval/index.js';
import { getRunArtifactPath } from '../../src/core/paths.js';
import { createProject } from '../../src/core/projects.js';
import { createRun } from '../../src/core/runs.js';
import { assertEvalSnapshot, BASELINES_DIR, readEvalSetFixture } from './evalSnapshots.js';
import {
  ALLOWED_AGGREGATE_METRICS,
  ALLOWED_PROOF_TAGS,
  EXPECTED_PROOF_TAGS_BY_CASE,
  PRIMARY_PROOF_TAG_BY_DIMENSION,
  buildActual,
  evaluateInvariant,
  evaluateRubric,
  matchesExpected,
  passesEvidenceSufficiency,
  passesFailClosed,
  passesProvenanceSufficiency,
  type ProofExpected,
  type ProofInput,
  type ProofMetadata,
  type ProofNormalizedActual,
  type ProofSurface,
  validateProofMetadata,
} from './researchQualityProofSchema.js';

vi.mock('../../src/api/client.js', () => ({
  getPaper: vi.fn(),
  getReferences: vi.fn(),
  search: vi.fn(),
}));

vi.mock('../../src/tools/research/reviewClassifier.js', () => ({
  classifyReviews: vi.fn(),
}));

const api = await import('../../src/api/client.js');
const { generateCriticalQuestions } = await import('../../src/tools/research/criticalQuestions.js');
const reviewClassifier = await import('../../src/tools/research/reviewClassifier.js');
const { performTheoreticalConflicts } = await import('../../src/tools/research/theoreticalConflicts.js');
const { traceToOriginal } = await import('../../src/tools/research/traceToOriginal.js');

function readJson<T>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as T;
}

function readJsonl<T>(filePath: string): T[] {
  return fs.readFileSync(filePath, 'utf-8')
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => JSON.parse(line) as T);
}

function makePaper(overrides: Record<string, unknown> = {}) {
  return {
    recid: '1001',
    title: 'A Review of Surprising Results',
    abstract: 'This breakthrough claims to revolutionize the field and prove a new discovery.',
    authors: ['Alice Example'],
    author_count: 1,
    year: 2018,
    citation_count: 60,
    publication_type: [],
    document_type: [],
    publication_summary: '',
    arxiv_categories: ['hep-th'],
    collaborations: [],
    ...overrides,
  };
}

async function withTempHepDataDir<T>(run: () => Promise<T>): Promise<T> {
  const original = process.env.HEP_DATA_DIR;
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hep-quality-proof-'));
  process.env.HEP_DATA_DIR = dataDir;
  try {
    return await run();
  } finally {
    if (original !== undefined) process.env.HEP_DATA_DIR = original;
    else delete process.env.HEP_DATA_DIR;
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

async function createSem04Run(): Promise<string> {
  const project = createProject({
    name: 'Research Quality Proof',
    description: 'Fixed-fixture eval',
  });
  const run = createRun({
    project_id: project.project_id,
    args_snapshot: { eval: 'research_quality_proof' },
  });
  return run.manifest.run_id;
}

async function runSem04Once(input: Extract<ProofInput, { surface: 'sem04' }>['payload']): Promise<ProofNormalizedActual> {
  return withTempHepDataDir(async () => {
    vi.resetAllMocks();
    vi.mocked(api.getPaper).mockImplementation(async (recid: string) => {
      const paper = input.papers.find(candidate => candidate.recid === recid);
      if (!paper) throw new Error(`missing recid mock: ${recid}`);
      return paper as never;
    });

    const run_id = await createSem04Run();
    const res = await performTheoreticalConflicts({
      run_id,
      recids: input.papers.map(paper => paper.recid),
      subject_entity: input.subject_entity,
      inputs: input.inputs,
      prompt_version: 'v2',
      max_candidates_total: 10,
      max_llm_requests: 10,
    }, {
      createMessage: vi.fn().mockResolvedValue({
        model: 'quality-proof-sem04',
        role: 'assistant',
        content: [{ type: 'text', text: JSON.stringify(input.sampling_response) }],
      }),
    });

    expect(res.summary).toBeTruthy();
    const conflicts = readJson<{
      conflicts: Array<{
        relation?: string;
        provenance?: { decision_status?: string; reason_code?: string };
      }>;
    }>(getRunArtifactPath(run_id, 'theoretical_conflicts_v1.json'));
    const firstEdge = conflicts.conflicts[0] ?? {};

    return buildActual('sem04', firstEdge.provenance?.decision_status ?? 'unknown', firstEdge.provenance?.reason_code ?? null, {
      decision_status: firstEdge.provenance?.decision_status ?? null,
      relation: firstEdge.relation ?? null,
    });
  });
}

async function runSem05Once(input: Extract<ProofInput, { surface: 'sem05' }>['payload']): Promise<ProofNormalizedActual> {
  vi.resetAllMocks();
  vi.mocked(api.getPaper).mockResolvedValueOnce(makePaper({ recid: input.recid, ...input.paper }) as never);
  vi.mocked(api.search).mockResolvedValue({
    total: input.comments_exist ? 1 : 0,
    papers: input.comments_exist ? [{ recid: 'c1', title: 'Comment' }] : [],
    has_more: false,
  } as never);

  const result = await generateCriticalQuestions({ recid: input.recid });
  expect(result.provenance).not.toHaveProperty('authority');

  return buildActual('sem05', result.provenance.status, result.provenance.reason_code, {
    paper_type: result.paper_type,
    provenance_status: result.provenance.status,
  });
}

async function runSem12Once(input: Extract<ProofInput, { surface: 'sem12' }>['payload']): Promise<ProofNormalizedActual> {
  vi.resetAllMocks();
  vi.mocked(api.getPaper).mockResolvedValueOnce(input.paper as never);
  vi.mocked(api.search).mockResolvedValueOnce({
    papers: input.candidates,
    total: input.candidates.length,
    has_more: false,
  } as never);
  const classification = input.paper.publication_type?.includes?.('review')
    ? {
        recid: String(input.paper.recid),
        title: String(input.paper.title),
        review_type: 'critical',
        coverage: { paper_count: 50, scope: 'moderate', author_diversity: 'single_group' },
        potential_biases: [],
        recency: 'current',
        age_years: 1,
        classification_confidence: 'high',
        provenance: {
          backend: 'mcp_sampling',
          status: 'applied',
          reason_code: 'review_semantics',
          prompt_version: 'sem05',
          input_hash: 'mock',
          model: 'mock-sem05',
        },
      }
    : {
        recid: String(input.paper.recid),
        title: String(input.paper.title),
        review_type: 'uncertain',
        coverage: { paper_count: 0, scope: 'uncertain', author_diversity: 'single_group' },
        potential_biases: [],
        recency: 'current',
        age_years: 1,
        classification_confidence: 'low',
        provenance: {
          backend: 'diagnostic',
          status: 'unavailable',
          reason_code: 'sampling_unavailable',
        },
      };
  vi.mocked(reviewClassifier.classifyReviews).mockResolvedValueOnce({
    success: true,
    classifications: [classification],
    summary: {
      total: 1,
      by_type: {
        catalog: 0,
        critical: classification.review_type === 'critical' ? 1 : 0,
        consensus: 0,
        uncertain: classification.review_type === 'uncertain' ? 1 : 0,
      },
      uncertain_count: classification.review_type === 'uncertain' ? 1 : 0,
    },
  } as never);

  const result = await traceToOriginal(
    { recid: String(input.paper.recid), max_candidates: 5 },
    input.sampling_response
      ? {
          createMessage: async () => ({
            model: 'quality-proof-sem12',
            role: 'assistant',
            content: [{ type: 'text', text: JSON.stringify(input.sampling_response) }],
          } as any),
        }
      : {},
  );

  expect(result.provenance).not.toHaveProperty('authority');

  return buildActual('sem12', result.status, result.provenance.reason_code, {
    matched_recid: result.original_paper?.recid ?? null,
    provenance_status: result.provenance.status,
    relationship: result.relationship,
  });
}

async function runProofOnce(input: ProofInput): Promise<ProofNormalizedActual> {
  switch (input.surface) {
    case 'sem04':
      return runSem04Once(input.payload);
    case 'sem05':
      return runSem05Once(input.payload);
    case 'sem12':
      return runSem12Once(input.payload);
  }
}

async function runProofCase(input: ProofInput): Promise<ProofNormalizedActual> {
  return runProofOnce(input);
}

function meanForTag(results: Array<EvalResult<ProofNormalizedActual>>, tag: string, metric: string): number {
  const scoped = results.filter(result => result.tags.includes(tag));
  if (scoped.length === 0) return 0;
  return scoped.reduce((sum, result) => sum + (result.metrics[metric] ?? 0), 0) / scoped.length;
}

function validateHarnessBoundary(evalSet: {
  description?: unknown;
  cases: Array<{ id: string; tags: string[]; metadata: unknown }>;
}): void {
  expect(evalSet.description).toBe(
    'Minimal fixed-fixture validity harness for bounded judgment checks on cleaned HEP research surfaces, not a benchmark, scorecard, or eval platform.',
  );

  const proofTagUniverse = new Set<string>();
  for (const evalCase of evalSet.cases) {
    validateProofMetadata(evalCase.metadata);
    const metadata = evalCase.metadata as ProofMetadata;
    const proofTags = evalCase.tags.filter(tag => tag.startsWith('proof:'));
    proofTags.forEach(tag => proofTagUniverse.add(tag));

    expect(proofTags).toContain('proof:trace_conformance');
    expect(proofTags).toEqual(EXPECTED_PROOF_TAGS_BY_CASE[evalCase.id as keyof typeof EXPECTED_PROOF_TAGS_BY_CASE]);
    expect(proofTags).toContain(PRIMARY_PROOF_TAG_BY_DIMENSION[metadata.quality_dimension]);
  }

  expect(Array.from(proofTagUniverse).sort()).toEqual([...ALLOWED_PROOF_TAGS].sort());
}

describe('eval: research-quality proof harness', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('locks a minimal judgment-quality proof on cleaned surfaces', async () => {
    const evalSet = readEvalSetFixture('research_quality_proof_eval.json');
    validateHarnessBoundary(evalSet as { description?: unknown; cases: Array<{ id: string; tags: string[]; metadata: unknown }> });
    const report = await runEvalSet<ProofInput, ProofNormalizedActual>(evalSet, {
      run: input => runProofCase(input),
      judge: (expected, actual, evalCase) => {
        const expectedProof = expected as ProofExpected;
        validateProofMetadata(evalCase.metadata);
        const metadata = evalCase.metadata as ProofMetadata;
        const canonicalTracePass = matchesExpected(actual, expectedProof);
        const primaryDimensionPass = evaluateRubric(actual, metadata) ? 1 : 0;
        const evidencePass = passesEvidenceSufficiency(actual) ? 1 : 0;
        const provenancePass = passesProvenanceSufficiency(actual) ? 1 : 0;
        const failClosedPass = passesFailClosed(actual) ? 1 : 0;
        const reproducibilityPass = canonicalTracePass ? 1 : 0;
        const applicableDimensions = evalCase.tags.filter(tag => tag.startsWith('proof:'));
        const dimensionScores = applicableDimensions.map(tag => {
          if (tag === 'proof:trace_conformance') return reproducibilityPass;
          if (tag === 'proof:evidence_sufficiency') return evidencePass;
          if (tag === 'proof:provenance_sufficiency') return provenancePass;
          if (tag === 'proof:fail_closed') return failClosedPass;
          return 0;
        });
        const partialProgress = dimensionScores.length === 0
          ? 0
          : dimensionScores.reduce((sum, value) => sum + value, 0) / dimensionScores.length;

        return {
          passed: primaryDimensionPass === 1 && reproducibilityPass === 1,
          metrics: {
            evidence_sufficiency_case: evalCase.tags.includes('proof:evidence_sufficiency') ? evidencePass : 0,
            provenance_sufficiency_case: evalCase.tags.includes('proof:provenance_sufficiency') ? provenancePass : 0,
            fail_closed_case: evalCase.tags.includes('proof:fail_closed') ? failClosedPass : 0,
            trace_conformance_case: evalCase.tags.includes('proof:trace_conformance') ? reproducibilityPass : 0,
          },
          outcome: {
            task_success: primaryDimensionPass === 1 && reproducibilityPass === 1,
            partial_progress: partialProgress,
          },
          resource_overhead: { token_usage: null, cost_usd: null },
        };
      },
      aggregate: results => ({
        evidence_sufficiency: meanForTag(results, 'proof:evidence_sufficiency', 'evidence_sufficiency_case'),
        provenance_sufficiency: meanForTag(results, 'proof:provenance_sufficiency', 'provenance_sufficiency_case'),
        fail_closed: meanForTag(results, 'proof:fail_closed', 'fail_closed_case'),
        trace_conformance: meanForTag(results, 'proof:trace_conformance', 'trace_conformance_case'),
        overall_gate_pass_rate: results.length === 0 ? 0 : results.filter(result => result.passed).length / results.length,
      }),
    });
    const traceSnapshot = report.caseResults.map(result => ({
      caseId: result.caseId,
      trace: result.actual
        ? {
            surface: result.actual.surface,
            verdict: result.actual.verdict,
            reason_code: result.actual.reason_code,
            state: result.actual.state,
          }
        : null,
    }));
    assertEvalSnapshot('research_quality_proof_trace', traceSnapshot);

    expect(report.summary.total).toBe(4);
    expect(report.summary.passRate).toBe(1);
    expect(report.aggregateMetrics.evidence_sufficiency).toBe(1);
    expect(report.aggregateMetrics.provenance_sufficiency).toBe(1);
    expect(report.aggregateMetrics.fail_closed).toBe(1);
    expect(report.aggregateMetrics.trace_conformance).toBe(1);
    expect(report.aggregateMetrics.overall_gate_pass_rate).toBe(1);
    expect(Object.keys(report.aggregateMetrics).sort()).toEqual([...ALLOWED_AGGREGATE_METRICS].sort());
    expect(report.aggregateOutcome.task_success_rate).toBe(1);
    expect(report.aggregateOutcome.partial_progress_mean).toBe(1);

    if (process.env.EVAL_UPDATE_BASELINES === '1') saveBaseline(report, BASELINES_DIR);
    const comparison = compareWithBaseline(report, loadBaseline(evalSet.name, BASELINES_DIR));
    expect(comparison.isFirstRun).toBe(false);
    expect(comparison.deltas.evidence_sufficiency?.delta ?? NaN).toBeCloseTo(0, 9);
    expect(comparison.deltas.provenance_sufficiency?.delta ?? NaN).toBeCloseTo(0, 9);
    expect(comparison.deltas.fail_closed?.delta ?? NaN).toBeCloseTo(0, 9);
    expect(comparison.deltas.trace_conformance?.delta ?? NaN).toBeCloseTo(0, 9);
    expect(comparison.deltas.overall_gate_pass_rate?.delta ?? NaN).toBeCloseTo(0, 9);
  });

  it('rejects traces by walking the real rubric invariant wiring from the fixed fixture metadata', () => {
    const evalSet = readEvalSetFixture('research_quality_proof_eval.json');
    const failClosedCase = evalSet.cases.find(evalCase => evalCase.id === 'sem12_missing_sampling_is_visible');
    const provenanceCase = evalSet.cases.find(evalCase => evalCase.id === 'sem12_provenance_match_is_sufficient');

    expect(failClosedCase).toBeTruthy();
    expect(provenanceCase).toBeTruthy();

    validateProofMetadata(failClosedCase?.metadata);
    validateProofMetadata(provenanceCase?.metadata);

    const failClosedMetadata = failClosedCase?.metadata as ProofMetadata;
    const provenanceMetadata = provenanceCase?.metadata as ProofMetadata;

    expect(failClosedMetadata.rubric.invariants).toEqual([
      'missing_sampling_must_not_guess_match',
      'unavailable_status_must_be_explicit',
    ]);
    expect(provenanceMetadata.rubric.invariants).toEqual([
      'matched_recid_must_be_present',
      'provenance_status_must_be_applied',
      'semantic_match_cannot_be_prior_only',
    ]);

    const failClosedInvariantOnlyBreak = buildActual('sem12', 'sampling_unavailable', 'sampling_unavailable', {
      matched_recid: null,
      provenance_status: 'diagnostic',
      relationship: 'unknown',
    });
    const guessedMatch = buildActual('sem12', 'sampling_unavailable', 'sampling_unavailable', {
      matched_recid: 'j4',
      provenance_status: 'unavailable',
      relationship: 'unknown',
    });
    const failClosedWiringMetadata: ProofMetadata = {
      ...failClosedMetadata,
      rubric: {
        ...failClosedMetadata.rubric,
        expected_trace: {
          verdict: failClosedInvariantOnlyBreak.verdict,
          reason_code: failClosedInvariantOnlyBreak.reason_code,
          state: failClosedInvariantOnlyBreak.state,
        },
      },
    };
    const failClosedGuessingMetadata: ProofMetadata = {
      ...failClosedMetadata,
      rubric: {
        ...failClosedMetadata.rubric,
        expected_trace: {
          verdict: guessedMatch.verdict,
          reason_code: guessedMatch.reason_code,
          state: guessedMatch.state,
        },
      },
    };
    const weakProvenance = buildActual('sem12', 'matched', 'semantic_content_match', {
      matched_recid: null,
      provenance_status: 'diagnostic',
      relationship: 'same_content',
    });

    expect(matchesExpected(failClosedInvariantOnlyBreak, failClosedWiringMetadata.rubric.expected_trace)).toBe(true);
    expect(passesFailClosed(failClosedInvariantOnlyBreak)).toBe(true);
    expect(evaluateInvariant('unavailable_status_must_be_explicit', failClosedInvariantOnlyBreak)).toBe(false);
    expect(evaluateRubric(failClosedInvariantOnlyBreak, failClosedWiringMetadata)).toBe(false);

    expect(matchesExpected(guessedMatch, failClosedGuessingMetadata.rubric.expected_trace)).toBe(true);
    expect(passesFailClosed(guessedMatch)).toBe(false);
    expect(evaluateInvariant('missing_sampling_must_not_guess_match', guessedMatch)).toBe(false);
    expect(evaluateRubric(guessedMatch, failClosedGuessingMetadata)).toBe(false);

    expect(evaluateRubric(weakProvenance, provenanceMetadata)).toBe(false);
    expect(passesProvenanceSufficiency(weakProvenance)).toBe(false);
    expect(evaluateInvariant('matched_recid_must_be_present', weakProvenance)).toBe(false);
  });
});
