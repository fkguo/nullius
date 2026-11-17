import { SemanticAssessmentProvenanceSchema } from '@nullius/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/api/client.js', () => ({
  getPaper: vi.fn(),
  getReferences: vi.fn(),
  search: vi.fn(),
}));

const api = await import('../../src/api/client.js');
const { classifyPaper } = await import('../../src/tools/research/paperClassifier.js');
const { classifyContentType } = await import('../../src/tools/research/paperClassifier.js');
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





  it('does not convert metadata-only review priors into scientific-priority judgments', async () => {
    vi.mocked(api.getPaper).mockResolvedValueOnce(makePaper({
      recid: '7007',
      publication_type: ['review'],
    }) as never);

    const result = await traceOriginalSource({ recid: '7007', max_depth: 1 });

    expect(result.trace_chain).toHaveLength(1);
    expect(result.analysis_scope.scientific_priority).toBe('not_assessed');
    expect(result.trace_chain[0]?.reference_lookup).toEqual({ status: 'not_requested', reason: 'depth_limit' });
    expect(result.trace_chain[0]).not.toHaveProperty('confidence_score');
    expect(result.trace_chain[0]).not.toHaveProperty('confidence');
    expect(result).not.toHaveProperty('original_sources');
    expect(api.getReferences).not.toHaveBeenCalled();
  });


});
