/**
 * Research Tools Tests
 * Tests for Phase 2 deep research tools
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the API client
vi.mock('../../src/api/client.js', () => ({
  batchGetPapers: vi.fn(),
  getPaper: vi.fn(),
  getReferences: vi.fn(),
  getCitations: vi.fn(),
}));

const api = await import('../../src/api/client.js');

describe('Research Tools', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('analyzePapers', () => {
    it('should analyze paper collection', async () => {
      const mockPapers = [
        { recid: '1', title: 'Paper 1', authors: ['Author A'], year: 2020, citation_count: 100 },
        { recid: '2', title: 'Paper 2', authors: ['Author B'], year: 2021, citation_count: 50 },
      ];

      vi.mocked(api.batchGetPapers).mockResolvedValueOnce(mockPapers);
      vi.mocked(api.getPaper).mockResolvedValue({
        ...mockPapers[0],
        collaborations: ['LHCb'],
        keywords: ['pentaquark'],
        arxiv_categories: ['hep-ph'],
      });

      const { analyzePapers } = await import('../../src/tools/research/analyzePapers.js');
      const result = await analyzePapers({ recids: ['1', '2'] });

      expect(result.item_count).toBe(2);
      expect(result.date_range.earliest).toBe('2020');
      expect(result.date_range.latest).toBe('2021');
    });

    it('builds multiple semantic topic clusters instead of a single keyword pile', async () => {
      const summaries = [
        { recid: '1', title: 'HNL detector study', authors: ['Author A'], year: 2024, citation_count: 30 },
        { recid: '2', title: 'Sterile-neutrino reinterpretation', authors: ['Author B'], year: 2025, citation_count: 25 },
        { recid: '3', title: 'Dispersive tetraquark amplitudes', authors: ['Author C'], year: 2025, citation_count: 21 },
      ];

      vi.mocked(api.batchGetPapers).mockResolvedValueOnce(summaries);
      vi.mocked(api.getPaper)
        .mockResolvedValueOnce({ ...summaries[0], abstract: 'Heavy neutral lepton search', keywords: ['lifetime frontier'] })
        .mockResolvedValueOnce({ ...summaries[1], abstract: 'Sterile neutrino sensitivity', keywords: ['long-lived leptons'] })
        .mockResolvedValueOnce({ ...summaries[2], abstract: 'Exotic hadron spectroscopy', keywords: ['tetraquark'] });

      const { analyzePapers } = await import('../../src/tools/research/analyzePapers.js');
      const result = await analyzePapers({ recids: ['1', '2', '3'], analysis_type: ['topics'] });

      expect(result.topics).toHaveLength(2);
      expect(result.topics?.map(group => group.paper_count).sort((a, b) => b - a)).toEqual([2, 1]);
      expect(result.topics?.every(group => group.keywords.length > 0)).toBe(true);
      expect(result.topics?.some(group => group.representative_papers.includes('1') && group.representative_papers.includes('2'))).toBe(true);
      expect(result.topics?.some(group => group.representative_papers.includes('3'))).toBe(true);
      const flattenedKeywords = result.topics?.flatMap(group => group.keywords) ?? [];
      expect(flattenedKeywords).not.toContain('heavy_neutral_lepton');
      expect(flattenedKeywords).not.toContain('exotic_hadron_spectroscopy');
    });
  });
});
