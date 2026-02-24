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
  });
});
