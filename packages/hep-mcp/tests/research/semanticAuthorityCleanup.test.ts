import { beforeEach, describe, expect, it, vi } from 'vitest';

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

describe('semantic authority cleanup regressions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.getReferences).mockResolvedValue([]);
    vi.mocked(api.search).mockResolvedValue({ total: 0, papers: [], has_more: false } as never);
  });

  it('does not treat title keywords as review authority without explicit metadata', () => {
    const classified = classifyPaper(makePaper());

    expect(classified.review_classification.decision).toBe('uncertain');
    expect(classified.paper_type).toBe('uncertain');
    expect(classified.review_classification.provenance.reason_code).toBe('insufficient_metadata');
  });

  it('returns unavailable review records instead of dropping fetch failures', async () => {
    vi.mocked(api.getPaper).mockRejectedValueOnce(new Error('boom'));

    const result = await classifyReviews({ recids: ['2002'] });

    expect(result.classifications).toHaveLength(1);
    expect(result.summary.total).toBe(1);
    expect(result.classifications[0]?.review_type).toBe('uncertain');
    expect(result.classifications[0]?.provenance.reason_code).toBe('paper_fetch_failed');
    expect(result.classifications[0]?.provenance.status).toBe('unavailable');
  });

  it('marks review sampling errors as unavailable fallback provenance', async () => {
    vi.mocked(api.getPaper).mockResolvedValueOnce(makePaper({
      recid: '3003',
      title: 'Explicit review metadata',
      publication_type: ['review'],
    }) as never);
    vi.mocked(api.getReferences).mockResolvedValueOnce([{ recid: 'r1' }, { recid: 'r2' }] as never);

    const result = await classifyReviews(
      { recids: ['3003'] },
      { createMessage: vi.fn().mockRejectedValue(new Error('Method not found')) },
    );

    expect(result.classifications[0]?.provenance.backend).toBe('mcp_sampling');
    expect(result.classifications[0]?.provenance.status).toBe('unavailable');
    expect(result.classifications[0]?.provenance.reason_code).toBe('sampling_error');
  });

  it('keeps fallback critical questions semantic-neutral when sampling is unavailable', async () => {
    vi.mocked(api.getPaper).mockResolvedValueOnce(makePaper({ recid: '4004' }) as never);

    const result = await generateCriticalQuestions({ recid: '4004' });

    expect(result.reliability_score).toBeNull();
    expect(result.red_flags.some(flag => flag.type === 'excessive_claims')).toBe(false);
    expect(result.provenance.reason_code).toBe('sampling_unavailable');
    expect(result.provenance.used_fallback).toBe(true);
  });

  it('returns unavailable provenance when critical-question sampling fails', async () => {
    vi.mocked(api.getPaper).mockResolvedValueOnce(makePaper({ recid: '5005' }) as never);

    const result = await generateCriticalQuestions(
      { recid: '5005' },
      { createMessage: vi.fn().mockRejectedValue(new Error('sampling offline')) },
    );

    expect(result.success).toBe(true);
    expect(result.reliability_score).toBeNull();
    expect(result.provenance.backend).toBe('mcp_sampling');
    expect(result.provenance.status).toBe('unavailable');
    expect(result.provenance.reason_code).toBe('sampling_error');
  });

  it('does not treat empty fallback assumption graphs as low-risk evidence', async () => {
    vi.mocked(api.getPaper).mockResolvedValueOnce(makePaper({
      recid: '6006',
      abstract: 'We compute observables numerically and compare to reference values.',
    }) as never);

    const result = await trackAssumptions({ recid: '6006' });

    expect(result.success).toBe(true);
    expect(result.analysis?.core_assumptions).toHaveLength(0);
    expect(result.analysis?.fragility_score).toBe(0.65);
    expect(result.risk_assessment?.level).toBe('medium');
    expect(result.risk_assessment?.description).toContain('empty graph');
    expect(result.provenance?.used_fallback).toBe(true);
  });
});
