/**
 * Golden Master Tests
 * Ensures complex tool outputs maintain consistent structure
 *
 * These tests verify output structure stability, not exact values.
 * They help catch breaking changes during refactoring.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MOCK_PAPER_SUMMARIES } from './mockData.js';

// Mock all external dependencies
vi.mock('../../src/api/client.js', () => ({
  search: vi.fn().mockResolvedValue({
    total: 3,
    papers: MOCK_PAPER_SUMMARIES,
    has_more: false,
  }),
  getPaper: vi.fn().mockResolvedValue({
    ...MOCK_PAPER_SUMMARIES[0],
    abstract: 'Test abstract',
  }),
  getReferences: vi.fn().mockResolvedValue(MOCK_PAPER_SUMMARIES),
  getCitations: vi.fn().mockResolvedValue({
    total: 10,
    papers: MOCK_PAPER_SUMMARIES,
  }),
  getAuthor: vi.fn().mockResolvedValue({
    name: 'Test Author',
    bai: 'Test.Author.1',
    affiliations: ['Test University'],
  }),
  getBibtex: vi.fn().mockResolvedValue('@article{test}'),
  searchAffiliation: vi.fn().mockResolvedValue({
    total: 1,
    papers: MOCK_PAPER_SUMMARIES,
  }),
  lookupById: vi.fn().mockResolvedValue(MOCK_PAPER_SUMMARIES[0]),
}));

// Mock rate limiter
vi.mock('../../src/api/rateLimiter.js', () => ({
  inspireFetch: vi.fn().mockResolvedValue({
    ok: true,
    json: () => Promise.resolve({ hits: { hits: [], total: 0 } }),
  }),
}));

describe('Golden Master: Tool Response Structure', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Tool response format', () => {
    it('search tool returns expected structure', async () => {
      const { handleToolCall } = await import('../../src/tools/index.js');

      const result = await handleToolCall('inspire_search', {
        query: 'hadronic molecules',
        size: 5,
      });

      // Verify MCP response structure
      expect(result).toHaveProperty('content');
      expect(Array.isArray(result.content)).toBe(true);
      expect(result.content.length).toBeGreaterThan(0);
      expect(result.content[0]).toHaveProperty('type', 'text');
      expect(result.content[0]).toHaveProperty('text');

      // Verify JSON structure in text
      const data = JSON.parse(result.content[0].text);
      expect(data).toHaveProperty('total');
      expect(data).toHaveProperty('papers');
      expect(Array.isArray(data.papers)).toBe(true);
    });

    it('get_paper tool returns expected structure', async () => {
      const { handleToolCall } = await import('../../src/tools/index.js');

      const result = await handleToolCall('inspire_literature', {
        mode: 'get_paper',
        recid: '1234567',
      });

      expect(result).toHaveProperty('content');
      expect(result.content[0]).toHaveProperty('type', 'text');

      const data = JSON.parse(result.content[0].text);
      expect(data).toHaveProperty('recid');
      expect(data).toHaveProperty('title');
    });

    it('get_references tool returns expected structure', async () => {
      const { handleToolCall } = await import('../../src/tools/index.js');

      const result = await handleToolCall('inspire_literature', {
        mode: 'get_references',
        recid: '1234567',
      });

      expect(result).toHaveProperty('content');
      const data = JSON.parse(result.content[0].text);
      expect(Array.isArray(data)).toBe(true);
    });
  });
});
