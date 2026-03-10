import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/api/client.js', () => ({
  getReferences: vi.fn(),
  getCitations: vi.fn(),
}));

const api = await import('../../src/api/client.js');

describe('generateSurvey', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('uses metadata-backed review classification instead of title keywords', async () => {
    vi.mocked(api.getReferences).mockResolvedValueOnce([
      {
        recid: 'r1',
        title: 'Overview of displaced-vertex searches',
        authors: ['A'],
        year: 2023,
        citation_count: 50,
        publication_type: [],
        document_type: [],
      },
      {
        recid: 'r2',
        title: 'Comprehensive status report on heavy neutral leptons',
        authors: ['B'],
        year: 2022,
        citation_count: 80,
        publication_type: ['review'],
        document_type: [],
      },
    ]);
    vi.mocked(api.getCitations).mockResolvedValue({ papers: [] });

    const { generateSurvey } = await import('../../src/tools/research/survey.js');
    const result = await generateSurvey({
      seed_recids: ['seed'],
      goal: 'quick_overview',
      max_papers: 5,
      prioritize: 'relevance',
      include_reviews: true,
    });

    const reviewSection = result.sections.find(section => section.name === 'Review Articles');
    expect(reviewSection?.papers.map(paper => paper.recid)).toEqual(['r2']);
  });
});
