import { SemanticAssessmentProvenanceSchema } from '@autoresearch/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/api/client.js', () => ({
  getPaper: vi.fn(),
  getReferences: vi.fn(),
  search: vi.fn(),
}));

const api = await import('../../src/api/client.js');
const { classifyPaper } = await import('../../src/tools/research/paperClassifier.js');
const { classifyContentType } = await import('../../src/tools/research/paperClassifier.js');
const { classifyReviews } = await import('../../src/tools/research/reviewClassifier.js');
const { generateCriticalQuestions } = await import('../../src/tools/research/criticalQuestions.js');
const { trackAssumptions } = await import('../../src/tools/research/assumptionTracker.js');
const { performCriticalAnalysis } = await import('../../src/tools/research/criticalAnalysis.js');
const { traceOriginalSource } = await import('../../src/tools/research/traceSource.js');

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

describe('semantic provenance cleanup regressions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.getReferences).mockResolvedValue([]);
    vi.mocked(api.search).mockResolvedValue({ total: 0, papers: [], has_more: false } as never);
  });

  it('does not treat title keywords as review provenance proof without explicit metadata', () => {
    const classified = classifyPaper(makePaper());

    expect(() => SemanticAssessmentProvenanceSchema.parse(classified.review_classification.provenance)).not.toThrow();
    expect(classified.review_classification.decision).toBe('uncertain');
    expect(classified.paper_type).toBe('uncertain');
    expect(classified.review_classification.provenance.reason_code).toBe('insufficient_metadata');
    expect(classified.review_classification.provenance).not.toHaveProperty('authority');
  });

  it('keeps explicit review metadata as diagnostic-only provenance', () => {
    const classified = classifyPaper(makePaper({
      publication_type: ['review'],
      document_type: ['article'],
    }));

    expect(classified.is_review).toBe(false);
    expect(classified.review_classification.decision).toBe('uncertain');
    expect(classified.paper_type).toBe('uncertain');
    expect(classified.review_classification.provenance.status).toBe('diagnostic');
    expect(classified.review_classification.provenance.reason_code).toBe('review_metadata_prior');
    expect(classified.review_classification.provenance).not.toHaveProperty('authority');
  });

  it('keeps explicit conference metadata as diagnostic-only provenance', () => {
    const classified = classifyPaper(makePaper({
      publication_type: ['conference paper'],
      document_type: ['article'],
    }));

    expect(classified.is_conference).toBe(false);
    expect(classified.conference_classification.decision).toBe('uncertain');
    expect(classified.paper_type).toBe('uncertain');
    expect(classified.conference_classification.provenance.reason_code).toBe('conference_metadata_prior');
    expect(classified.paper_type_provenance.reason_code).toBe('conference_metadata_prior');
    expect(classified.conference_classification.provenance.status).toBe('diagnostic');
    expect(classified.conference_classification.provenance).not.toHaveProperty('authority');
  });

  it('keeps arxiv category content labels as priors only', () => {
    const content = classifyContentType(makePaper({
      arxiv_categories: ['hep-th'],
      publication_type: [],
      document_type: [],
    }));

    expect(content.content_type).toBe('uncertain');
    expect(content.theoretical_score).toBe(1);
    expect(content.provenance.status).toBe('diagnostic');
    expect(content.provenance.reason_code).toBe('theoretical_arxiv_prior');
    expect(content.provenance).not.toHaveProperty('authority');
  });

  it('returns unavailable review records instead of dropping fetch failures', async () => {
    vi.mocked(api.getPaper).mockRejectedValueOnce(new Error('boom'));

    const result = await classifyReviews({ recids: ['2002'] });

    expect(() => SemanticAssessmentProvenanceSchema.parse(result.classifications[0]?.provenance)).not.toThrow();
    expect(result.success).toBe(false);
    expect(result.classifications).toHaveLength(1);
    expect(result.summary.total).toBe(1);
    expect(result.classifications[0]?.review_type).toBe('uncertain');
    expect(result.classifications[0]).not.toHaveProperty('authority_score');
    expect(result.classifications[0]).not.toHaveProperty('is_authoritative_source');
    expect(result.summary).not.toHaveProperty('authoritative_count');
    expect(result.summary).not.toHaveProperty('average_authority_score');
    expect(result.classifications[0]?.provenance.reason_code).toBe('paper_fetch_failed');
    expect(result.classifications[0]?.provenance.status).toBe('unavailable');
    expect(result.classifications[0]?.provenance).not.toHaveProperty('authority');
  });

  it('marks review sampling errors as unavailable semantic provenance', async () => {
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

    expect(() => SemanticAssessmentProvenanceSchema.parse(result.classifications[0]?.provenance)).not.toThrow();
    expect(result.success).toBe(false);
    expect(result.classifications[0]?.provenance.backend).toBe('mcp_sampling');
    expect(result.classifications[0]?.provenance.status).toBe('unavailable');
    expect(result.classifications[0]?.provenance.reason_code).toBe('sampling_error');
    expect(result.classifications[0]?.provenance).not.toHaveProperty('authority');
  });

  it('fails closed when critical-question sampling is unavailable', async () => {
    vi.mocked(api.getPaper).mockResolvedValueOnce(makePaper({ recid: '4004' }) as never);

    const result = await generateCriticalQuestions({ recid: '4004' });

    expect(() => SemanticAssessmentProvenanceSchema.parse(result.provenance)).not.toThrow();
    expect(result.success).toBe(false);
    expect(result).not.toHaveProperty('reliability_score');
    expect(result.red_flags.some(flag => flag.type === 'excessive_claims')).toBe(false);
    expect(result.provenance.reason_code).toBe('sampling_required');
    expect(result.provenance).not.toHaveProperty('authority');
  });

  it('returns unavailable provenance when critical-question sampling fails', async () => {
    vi.mocked(api.getPaper).mockResolvedValueOnce(makePaper({ recid: '5005' }) as never);

    const result = await generateCriticalQuestions(
      { recid: '5005' },
      { createMessage: vi.fn().mockRejectedValue(new Error('sampling offline')) },
    );

    expect(() => SemanticAssessmentProvenanceSchema.parse(result.provenance)).not.toThrow();
    expect(result.success).toBe(false);
    expect(result).not.toHaveProperty('reliability_score');
    expect(result.provenance.backend).toBe('mcp_sampling');
    expect(result.provenance.status).toBe('unavailable');
    expect(result.provenance.reason_code).toBe('sampling_error');
    expect(result.provenance).not.toHaveProperty('authority');
  });

  it('does not convert metadata-only review priors into trace-source confidence bonuses', async () => {
    vi.mocked(api.getPaper).mockResolvedValueOnce(makePaper({
      recid: '7007',
      publication_type: ['review'],
    }) as never);

    const result = await traceOriginalSource({ recid: '7007', max_depth: 1 });

    expect(result.trace_chain).toHaveLength(1);
    expect(result.trace_chain[0]?.review_classification.decision).toBe('uncertain');
    expect(result.trace_chain[0]?.review_classification.provenance.reason_code).toBe('review_metadata_prior');
    expect(result.trace_chain[0]?.confidence_score).toBeLessThan(0.5);
    expect(result.trace_chain[0]?.confidence).not.toBe('likely_original');
  });

  it('fails closed when semantic assumption tracking is unavailable', async () => {
    vi.mocked(api.getPaper).mockResolvedValueOnce(makePaper({
      recid: '6006',
      abstract: 'We compute observables numerically and compare to reference values.',
    }) as never);

    const result = await trackAssumptions({ recid: '6006' });

    expect(() => SemanticAssessmentProvenanceSchema.parse(result.provenance)).not.toThrow();
    expect(result.success).toBe(false);
    expect(result.analysis).toBeNull();
    expect(result.provenance?.reason_code).toBe('sampling_required');
    expect(result.provenance).not.toHaveProperty('authority');
  });

  it('exposes component_status when critical analysis fails closed on sampling-unavailable components', async () => {
    vi.mocked(api.getPaper).mockResolvedValue(makePaper({ recid: '9009' }) as never);

    const result = await performCriticalAnalysis({
      recid: '9009',
      include_evidence: false,
      include_questions: true,
      include_assumptions: true,
    });

    expect(result.success).toBe(false);
    expect(result.component_status).toMatchObject({
      evidence: {
        requested: false,
        status: 'not_requested',
        available_output: false,
      },
      questions: {
        requested: true,
        status: 'unavailable',
        reason_code: 'sampling_required',
        available_output: true,
      },
      assumptions: {
        requested: true,
        status: 'unavailable',
        reason_code: 'sampling_required',
        available_output: false,
      },
    });
    expect(result.integrated_assessment).not.toHaveProperty('reliability_score');
    expect(result.integrated_assessment).not.toHaveProperty('verdict');
  });
});
