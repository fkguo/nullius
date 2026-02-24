import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/api/rateLimiter.js', () => ({
  inspireFetch: vi.fn(),
}));

const api = await import('../../src/api/client.js');
const rateLimiter = await import('../../src/api/rateLimiter.js');

function makeHit(controlNumber: number) {
  return {
    metadata: {
      control_number: controlNumber,
      titles: [{ title: `T${controlNumber}` }],
      authors: [{ full_name: 'A' }],
      earliest_date: '2020-01-01',
      citation_count: 0,
      citation_count_without_self_citations: 0,
      publication_info: [],
      arxiv_eprints: [],
      dois: [],
      publication_type: [],
      document_type: [],
      texkeys: [],
    },
  };
}

describe('API Client: searchAll', () => {
  const inspireFetch = vi.mocked(rateLimiter.inspireFetch);

  beforeEach(() => {
    inspireFetch.mockReset();
  });

  it('paginates until all results are fetched', async () => {
    inspireFetch.mockImplementation(async (url: string) => {
      const u = new URL(url);
      const page = Number(u.searchParams.get('page') ?? '1');
      const size = Number(u.searchParams.get('size') ?? '10');

      const total = 5;
      const startIdx = (page - 1) * size;
      const remaining = total - startIdx;
      const count = Math.max(0, Math.min(size, remaining));

      const hits = Array.from({ length: count }, (_, i) => makeHit(startIdx + i + 1));
      const hasMore = startIdx + count < total;

      return {
        ok: true,
        status: 200,
        json: async () => ({
          hits: { total, hits },
          links: hasMore ? { next: 'next' } : {},
        }),
      } as any;
    });

    const res = await api.searchAll('test_searchAll_paginates', { size: 2 });
    expect(res.total).toBe(5);
    expect(res.papers).toHaveLength(5);
    expect(res.has_more).toBe(false);
    expect(inspireFetch).toHaveBeenCalledTimes(3);
  });

  it('respects max_results truncation and reports has_more', async () => {
    inspireFetch.mockImplementation(async (url: string) => {
      const u = new URL(url);
      const page = Number(u.searchParams.get('page') ?? '1');
      const size = Number(u.searchParams.get('size') ?? '10');

      const total = 5;
      const startIdx = (page - 1) * size;
      const remaining = total - startIdx;
      const count = Math.max(0, Math.min(size, remaining));

      const hits = Array.from({ length: count }, (_, i) => makeHit(startIdx + i + 1));
      const hasMore = startIdx + count < total;

      return {
        ok: true,
        status: 200,
        json: async () => ({
          hits: { total, hits },
          links: hasMore ? { next: 'next' } : {},
        }),
      } as any;
    });

    const res = await api.searchAll('test_searchAll_truncates', { size: 2, max_results: 3 });
    expect(res.total).toBe(5);
    expect(res.papers).toHaveLength(3);
    expect(res.has_more).toBe(true);
    expect(res.warning).toContain('max_results=3');
  });
});

