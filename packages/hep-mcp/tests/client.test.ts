/**
 * API Client Tests
 * Tests for INSPIRE API client functions
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock fetch for testing (avoid leaking across test files)
const mockFetch = vi.fn();

// Import after mocking
const clientModule = await import('../src/api/client.js');
const { clearAllCaches } = await import('../src/cache/memoryCache.js');

describe('API Client', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', mockFetch as any);
    mockFetch.mockReset();
    clearAllCaches();  // Clear cache before each test
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('search', () => {
    it('should return search results', async () => {
      const mockResponse = {
        hits: {
          total: 1,
          hits: [
            {
              metadata: {
                control_number: '12345',
                titles: [{ title: 'Test Paper' }],
                authors: [{ full_name: 'Test Author' }],
                earliest_date: '2024-01-01',
                citation_count: 10,
              },
            },
          ],
        },
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockResponse),
      });

      const result = await clientModule.search('test query');

      expect(result.total).toBe(1);
      expect(result.papers).toHaveLength(1);
      expect(result.papers[0].recid).toBe('12345');
      expect(result.papers[0].title).toBe('Test Paper');
    });

    it('should handle empty results', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ hits: { total: 0, hits: [] } }),
      });

      const result = await clientModule.search('nonexistent');

      expect(result.total).toBe(0);
      expect(result.papers).toHaveLength(0);
    });

    it('should throw on API error', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
      });

      await expect(clientModule.search('test')).rejects.toThrow();
    });

    it('should handle pagination options', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ hits: { total: 100, hits: [] }, links: { next: 'http://next' } }),
      });

      const result = await clientModule.search('test', { size: 20, page: 2, sort: 'mostcited' });

      expect(result.has_more).toBe(true);
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('size=20'),
        expect.any(Object)
      );
    });

    it('should pass arxiv_categories as a separate URL parameter', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ hits: { total: 0, hits: [] } }),
      });

      await clientModule.search('j:Rev.Mod.Phys.', { arxiv_categories: 'hep-ph' });

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const url = String(mockFetch.mock.calls[0]?.[0]);
      const parsed = new URL(url);

      expect(parsed.searchParams.get('q')).toBe('j:Rev.Mod.Phys.');
      expect(parsed.searchParams.get('arxiv_categories')).toBe('hep-ph');
    });

    it('should cache by arxiv_categories (no collisions)', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ hits: { total: 0, hits: [] } }),
      });
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ hits: { total: 0, hits: [] } }),
      });

      await clientModule.search('j:Rev.Mod.Phys.', { arxiv_categories: 'hep-ph' });
      await clientModule.search('j:Rev.Mod.Phys.', { arxiv_categories: 'hep-th' });

      expect(mockFetch).toHaveBeenCalledTimes(2);

      const url1 = String(mockFetch.mock.calls[0]?.[0]);
      const url2 = String(mockFetch.mock.calls[1]?.[0]);
      expect(url1).toContain('arxiv_categories=hep-ph');
      expect(url2).toContain('arxiv_categories=hep-th');
    });

    it('should extract arXiv ID and DOI', async () => {
      const mockResponse = {
        hits: {
          total: 1,
          hits: [
            {
              metadata: {
                control_number: '12345',
                titles: [{ title: 'Test' }],
                authors: [],
                arxiv_eprints: [{ value: '2301.12345' }],
                dois: [{ value: '10.1103/PhysRevD.100.014001' }],
              },
            },
          ],
        },
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockResponse),
      });

      const result = await clientModule.search('test');

      expect(result.papers[0].arxiv_id).toBe('2301.12345');
      expect(result.papers[0].doi).toBe('10.1103/PhysRevD.100.014001');
      expect(result.papers[0].arxiv_url).toBe('https://arxiv.org/abs/2301.12345');
      expect(result.papers[0].doi_url).toBe('https://doi.org/10.1103/PhysRevD.100.014001');
    });
  });

  describe('getPaper', () => {
    it('should return paper details', async () => {
      const mockResponse = {
        metadata: {
          control_number: '12345',
          titles: [{ title: 'Detailed Paper' }],
          authors: [{ full_name: 'Author One' }],
          abstracts: [{ value: 'This is the abstract' }],
          collaborations: [{ value: 'LHCb' }],
          keywords: [{ value: 'pentaquark' }],
          arxiv_eprints: [{ value: '2301.12345', categories: ['hep-ex'] }],
        },
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockResponse),
      });

      const paper = await clientModule.getPaper('12345');

      expect(paper.recid).toBe('12345');
      expect(paper.title).toBe('Detailed Paper');
      expect(paper.abstract).toBe('This is the abstract');
      expect(paper.collaborations).toContain('LHCb');
      expect(paper.keywords).toContain('pentaquark');
      expect(paper.arxiv_categories).toContain('hep-ex');
    });

    it('should throw on 404', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
      });

      await expect(clientModule.getPaper('nonexistent')).rejects.toThrow();
    });
  });

  describe('getReferences', () => {
    it('should return references list', async () => {
      const mockResponse = {
        metadata: {
          references: [
            {
              record: { '$ref': 'https://inspirehep.net/api/literature/11111' },
              reference: {
                title: { title: 'Reference Paper 1' },
                authors: [{ full_name: 'Ref Author' }],
                publication_info: { year: 2020 },
              },
            },
            {
              record: { '$ref': 'https://inspirehep.net/api/literature/22222' },
              reference: {
                title: { title: 'Reference Paper 2' },
                authors: [],
              },
            },
          ],
        },
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockResponse),
      });

      const refs = await clientModule.getReferences('12345');

      expect(refs).toHaveLength(2);
      expect(refs[0].recid).toBe('11111');
      expect(refs[0].title).toBe('Reference Paper 1');
      expect(refs[1].recid).toBe('22222');
    });

    it('should handle size limit', async () => {
      const mockResponse = {
        metadata: {
          references: Array(10).fill({
            record: { '$ref': 'https://inspirehep.net/api/literature/11111' },
            reference: { title: { title: 'Ref' }, authors: [] },
          }),
        },
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockResponse),
      });

      const refs = await clientModule.getReferences('12345', 5);

      expect(refs).toHaveLength(5);
    });
  });

  describe('getCitations', () => {
    it('should return citing papers', async () => {
      const mockResponse = {
        hits: {
          total: 50,
          hits: [
            {
              metadata: {
                control_number: '99999',
                titles: [{ title: 'Citing Paper' }],
                authors: [{ full_name: 'Citing Author' }],
              },
            },
          ],
        },
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockResponse),
      });

      const result = await clientModule.getCitations('12345');

      expect(result.total).toBe(50);
      expect(result.papers[0].title).toBe('Citing Paper');
      // Verify the query uses refersto:recid:
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('refersto%3Arecid%3A12345'),
        expect.any(Object)
      );
    });
  });

  describe('getBibtex', () => {
    it('should return bibtex string', async () => {
      const mockBibtex = '@article{Test:2024abc,\n  title={Test Paper}\n}';

      mockFetch.mockResolvedValueOnce({
        ok: true,
        text: () => Promise.resolve(mockBibtex),
      });

      const bibtex = await clientModule.getBibtex(['12345']);

      expect(bibtex).toContain('@article');
      expect(bibtex).toContain('Test Paper');
    });

    it('should handle multiple recids', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        text: () => Promise.resolve('@article{a}\n@article{b}'),
      });

      await clientModule.getBibtex(['111', '222', '333']);

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('recid%3A111'),
        expect.any(Object)
      );
    });
  });

  describe('batchGetPapers', () => {
    it('should batch fetch papers', async () => {
      const mockResponse = {
        hits: {
          total: 2,
          hits: [
            { metadata: { control_number: '111', titles: [{ title: 'Paper 1' }], authors: [] } },
            { metadata: { control_number: '222', titles: [{ title: 'Paper 2' }], authors: [] } },
          ],
        },
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockResponse),
      });

      const papers = await clientModule.batchGetPapers(['111', '222']);

      expect(papers).toHaveLength(2);
    });

    it('should handle empty input', async () => {
      const papers = await clientModule.batchGetPapers([]);
      expect(papers).toHaveLength(0);
    });

    it('should deduplicate recids', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ hits: { total: 1, hits: [{ metadata: { control_number: '111', titles: [{ title: 'P' }], authors: [] } }] } }),
      });

      await clientModule.batchGetPapers(['111', '111', '111']);

      // Should only query once for unique recid
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });
  });

  describe('getAuthor', () => {
    it('should get author by BAI', async () => {
      const mockResponse = {
        hits: {
          hits: [
            {
              metadata: {
                control_number: '1000',
                name: { preferred_name: 'Edward Witten', value: 'Witten, Edward' },
                ids: [
                  { schema: 'INSPIRE BAI', value: 'E.Witten.1' },
                  { schema: 'ORCID', value: '0000-0001-2345-6789' },
                ],
                positions: [{ institution: 'IAS Princeton', current: true }],
              },
            },
          ],
        },
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockResponse),
      });

      const author = await clientModule.getAuthor('E.Witten.1');

      expect(author.name).toBe('Edward Witten');
      expect(author.bai).toBe('E.Witten.1');
      expect(author.orcid).toBe('0000-0001-2345-6789');
    });

    it('should get author by ORCID', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          metadata: {
            name: { preferred_name: 'Test Author' },
            ids: [],
            positions: [],
          },
        }),
      });

      const author = await clientModule.getAuthor('0000-0001-2345-6789');

      expect(author.name).toBe('Test Author');
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/orcid/'),
        expect.any(Object)
      );
    });

    it('should throw error when author not found', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ hits: { hits: [] } }),
      });

      // Implementation throws error when author not found
      await expect(clientModule.getAuthor('nonexistent')).rejects.toThrow('Author not found');
    });
  });

  describe('getByArxiv', () => {
    it('accepts arXiv: prefix and strips version suffix', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          metadata: {
            control_number: '2914144',
            titles: [{ title: 'Test by arXiv' }],
            authors: [],
            arxiv_eprints: [{ value: '2504.14997' }],
          },
        }),
      });

      const result = await clientModule.getByArxiv('arXiv:2504.14997v2');

      expect(result.recid).toBe('2914144');
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/api/arxiv/2504.14997'),
        expect.any(Object)
      );
    });

    it('throws INVALID_PARAMS on malformed arXiv identifier', async () => {
      await expect(clientModule.getByArxiv('arXiv:not-a-valid-id')).rejects.toMatchObject({
        code: 'INVALID_PARAMS',
      });
    });

    it('404 includes normalized arXiv id in error payload', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
      });

      await expect(clientModule.getByArxiv('arXiv:2504.14997')).rejects.toMatchObject({
        code: 'UPSTREAM_ERROR',
        data: expect.objectContaining({
          status: 404,
          normalized_arxiv_id: '2504.14997',
        }),
      });
    });
  });
});
