import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/api/client.js', () => ({
  searchAll: vi.fn(),
  getReferences: vi.fn(),
  getCitations: vi.fn(),
  batchGetPapers: vi.fn(),
}));

vi.mock('../../src/tools/research/traceToOriginal.js', () => ({
  traceToOriginal: vi.fn(),
}));

vi.mock('../../src/tools/research/seminalPapers.js', () => ({
  findSeminalPapers: vi.fn(),
}));

vi.mock('../../src/tools/research/conflictDetector.js', () => ({
  detectConflicts: vi.fn(),
}));

const api = await import('../../src/api/client.js');
const traceToOriginal = await import('../../src/tools/research/traceToOriginal.js');
const seminalPapers = await import('../../src/tools/research/seminalPapers.js');
const conflictDetector = await import('../../src/tools/research/conflictDetector.js');
const { performFieldSurvey } = await import('../../src/tools/research/fieldSurvey.js');

describe('fieldSurvey provenance conservatism', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('keeps conference papers when provenance remains uncertain', async () => {
    vi.mocked(api.searchAll).mockResolvedValueOnce({ papers: [] } as any);
    vi.mocked(seminalPapers.findSeminalPapers).mockResolvedValueOnce({
      seminal_papers: [{ recid: 'seed1', title: 'Seed', authors: ['A'], year: 2020 }],
    } as any);
    vi.mocked(api.batchGetPapers).mockResolvedValueOnce([{ recid: 'seed1', title: 'Seed', authors: ['A'], year: 2020 }] as any);
    vi.mocked(api.getCitations).mockResolvedValueOnce({
      papers: [{
        recid: 'conf1',
        title: 'Conference version',
        authors: ['A'],
        year: 2021,
        citation_count: 80,
        publication_type: ['conference paper'],
        document_type: ['conference paper'],
      }],
    } as any);
    vi.mocked(api.getReferences).mockResolvedValue([] as any);
    vi.mocked(traceToOriginal.traceToOriginal).mockResolvedValueOnce({
      status: 'uncertain',
      success: false,
      conference_paper: { recid: 'conf1', title: 'Conference version', authors: ['A'] },
      original_paper: null,
      relationship: 'unknown',
      confidence: 0.33,
      provenance: { backend: 'mcp_sampling', status: 'applied', used_fallback: false, reason_code: 'multiple_plausible_candidates' },
      candidate_count: 2,
      candidate_diagnostics: [],
    } as any);
    vi.mocked(conflictDetector.detectConflicts).mockResolvedValueOnce({ conflicts: [] } as any);

    const result = await performFieldSurvey({
      topic: 'bootstrap',
      iterations: 1,
      prefer_journal: true,
      focus: ['open_questions'],
    });

    expect(traceToOriginal.traceToOriginal).not.toHaveBeenCalled();
    expect(result.citation_network.all_papers.some(paper => paper.recid === 'conf1')).toBe(true);
    expect(result.stats.conference_papers_traced).toBe(0);
  });
});
