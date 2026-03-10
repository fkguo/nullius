import { beforeEach, describe, expect, it, vi } from 'vitest';

import { readEvalSetFixture } from './evalSnapshots.js';

vi.mock('../../src/api/client.js', () => ({
  getPaper: vi.fn(),
  getReferences: vi.fn(),
  search: vi.fn(),
}));

const api = await import('../../src/api/client.js');
const { classifyPaper } = await import('../../src/tools/research/paperClassifier.js');
const { classifyReviews } = await import('../../src/tools/research/reviewClassifier.js');
const { generateCriticalQuestions } = await import('../../src/tools/research/criticalQuestions.js');
const { trackAssumptions } = await import('../../src/tools/research/assumptionTracker.js');

type Sem05Input =
  | { kind: 'paper_classifier'; paper: Record<string, unknown> }
  | { kind: 'critical_questions'; recid: string; paper: Record<string, unknown>; comments_exist?: boolean }
  | { kind: 'assumption_tracker'; recid: string; paper: Record<string, unknown>; references?: Array<Record<string, unknown>> }
  | { kind: 'review_classifier'; recid: string; references?: Array<Record<string, unknown>>; fail_get_paper?: boolean };

type Sem05Actual = Record<string, unknown>;

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

async function runSem05Case(input: Sem05Input): Promise<Sem05Actual> {
  vi.clearAllMocks();
  vi.mocked(api.getReferences).mockResolvedValue((input.kind === 'assumption_tracker' ? input.references : []) as never);
  vi.mocked(api.search).mockResolvedValue({
    total: input.kind === 'critical_questions' && input.comments_exist ? 1 : 0,
    papers: input.kind === 'critical_questions' && input.comments_exist ? [{ recid: 'c1', title: 'Comment' }] : [],
    has_more: false,
  } as never);

  switch (input.kind) {
    case 'paper_classifier': {
      const result = classifyPaper(makePaper(input.paper));
      return {
        paper_type: result.paper_type,
        review_decision: result.review_classification.decision,
        used_fallback: result.review_classification.provenance.used_fallback,
        reason_code: result.review_classification.provenance.reason_code,
      };
    }
    case 'critical_questions': {
      vi.mocked(api.getPaper).mockResolvedValueOnce(makePaper({ recid: input.recid, ...input.paper }) as never);
      const result = await generateCriticalQuestions({ recid: input.recid });
      return {
        reliability_score: result.reliability_score,
        red_flag_types: result.red_flags.map(flag => flag.type),
        used_fallback: result.provenance.used_fallback,
        reason_code: result.provenance.reason_code,
      };
    }
    case 'assumption_tracker': {
      vi.mocked(api.getPaper).mockResolvedValueOnce(makePaper({ recid: input.recid, ...input.paper }) as never);
      const result = await trackAssumptions({ recid: input.recid });
      return {
        fragility_score: result.analysis?.fragility_score ?? null,
        risk_level: result.risk_assessment?.level ?? null,
        used_fallback: result.provenance?.used_fallback ?? null,
        reason_code: result.provenance?.reason_code ?? null,
      };
    }
    case 'review_classifier': {
      if (input.fail_get_paper) {
        vi.mocked(api.getPaper).mockRejectedValueOnce(new Error('boom'));
      } else {
        vi.mocked(api.getPaper).mockResolvedValueOnce(makePaper({ recid: input.recid, publication_type: ['review'] }) as never);
      }
      vi.mocked(api.getReferences).mockResolvedValueOnce((input.references ?? []) as never);
      const result = await classifyReviews({ recids: [input.recid] });
      return {
        total: result.summary.total,
        review_type: result.classifications[0]?.review_type ?? null,
        reason_code: result.classifications[0]?.provenance.reason_code ?? null,
        status: result.classifications[0]?.provenance.status ?? null,
      };
    }
  }
}

function assertSem05Case(actual: Sem05Actual, expected: Record<string, unknown>) {
  if ('forbidden_red_flags' in expected) {
    expect(actual.red_flag_types).toEqual(expect.not.arrayContaining(expected.forbidden_red_flags as unknown[]));
  }
  if ('fragility_min' in expected) {
    expect((actual.fragility_score as number) ?? 0).toBeGreaterThanOrEqual(expected.fragility_min as number);
  }
  for (const [key, value] of Object.entries(expected)) {
    if (key === 'forbidden_red_flags' || key === 'fragility_min') continue;
    expect(actual[key]).toEqual(value);
  }
}

describe('eval: sem05 semantic authority cleanup', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('passes the eval hard cases', async () => {
    const evalSet = readEvalSetFixture('sem05/sem05_semantic_authority_eval.json');
    for (const testCase of evalSet.cases) {
      const actual = await runSem05Case(testCase.input as Sem05Input);
      assertSem05Case(actual, testCase.expected as Record<string, unknown>);
    }
  });

  it('passes the holdout hard cases', async () => {
    const evalSet = readEvalSetFixture('sem05/sem05_semantic_authority_holdout.json');
    for (const testCase of evalSet.cases) {
      const actual = await runSem05Case(testCase.input as Sem05Input);
      assertSem05Case(actual, testCase.expected as Record<string, unknown>);
    }
  });
});
