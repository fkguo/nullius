import { beforeEach, describe, expect, it, vi } from 'vitest';

import { readEvalSetFixture } from './evalSnapshots.js';

vi.mock('../../src/api/client.js', () => ({
  getPaper: vi.fn(),
  search: vi.fn(),
}));

vi.mock('../../src/tools/research/reviewClassifier.js', () => ({
  classifyReviews: vi.fn(),
}));

const api = await import('../../src/api/client.js');
const reviewClassifier = await import('../../src/tools/research/reviewClassifier.js');
const { traceToOriginal } = await import('../../src/tools/research/traceToOriginal.js');

type Sem12Input = {
  paper: Record<string, unknown>;
  candidates: Array<Record<string, unknown>>;
  sampling_response: Record<string, unknown> | null;
};

async function runSem12Case(input: Sem12Input) {
  vi.resetAllMocks();
  vi.mocked(api.getPaper).mockResolvedValueOnce(input.paper as any);
  vi.mocked(api.search).mockResolvedValueOnce({
    papers: input.candidates,
    total: input.candidates.length,
    has_more: false,
  } as any);
  vi.mocked(reviewClassifier.classifyReviews).mockResolvedValueOnce({
    success: true,
    classifications: [input.paper.publication_type?.includes?.('review')
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
          authority: 'semantic_conclusion',
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
          authority: 'unavailable',
          reason_code: 'sampling_unavailable',
        },
      }],
    summary: { total: 1, by_type: { catalog: 0, critical: 0, consensus: 0, uncertain: 1 }, uncertain_count: 1 },
  } as any);

  const result = await traceToOriginal(
    { recid: String(input.paper.recid), max_candidates: 5 },
    input.sampling_response
      ? {
        createMessage: async () => ({
          model: 'mock-sem12',
          role: 'assistant',
          content: [{ type: 'text', text: JSON.stringify(input.sampling_response) }],
        } as any),
      }
      : {},
  );

  return {
    status: result.status,
    success: result.success,
    matched_recid: result.original_paper?.recid ?? null,
    relationship: result.relationship,
    reason_code: result.provenance.reason_code,
    provenance_status: result.provenance.status,
  };
}

describe('eval: sem12 provenance matcher', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('passes the eval hard cases', async () => {
    const evalSet = readEvalSetFixture('sem12/sem12_provenance_matcher_eval.json');
    for (const testCase of evalSet.cases) {
      const actual = await runSem12Case(testCase.input as Sem12Input);
      expect(actual).toEqual(testCase.expected);
    }
  });

  it('passes the holdout hard cases', async () => {
    const evalSet = readEvalSetFixture('sem12/sem12_provenance_matcher_holdout.json');
    for (const testCase of evalSet.cases) {
      const actual = await runSem12Case(testCase.input as Sem12Input);
      expect(actual).toEqual(testCase.expected);
    }
  });
});
