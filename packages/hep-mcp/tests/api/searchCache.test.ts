import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/api/rateLimiter.js', () => ({
  inspireFetch: vi.fn(),
}));

const api = await import('../../src/api/client.js');
const rateLimiter = await import('../../src/api/rateLimiter.js');
const memoryCache = await import('../../src/cache/memoryCache.js');

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

describe('API Client: search cache', () => {
  const inspireFetch = vi.mocked(rateLimiter.inspireFetch);

  beforeEach(() => {
    memoryCache.clearAllCaches();
    inspireFetch.mockReset();
  });

  it('keeps next_url/has_more when returning cached search results', async () => {
    const nextUrl = 'https://inspirehep.net/api/literature?page=2&size=1&q=x';

    inspireFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        hits: { total: 2, hits: [makeHit(1)] },
        links: { next: nextUrl },
      }),
    } as any);

    const first = await api.search('x', { size: 1, page: 1 });
    expect(first.has_more).toBe(true);
    expect(first.next_url).toBe(nextUrl);

    const second = await api.search('x', { size: 1, page: 1 });
    expect(second.has_more).toBe(true);
    expect(second.next_url).toBe(nextUrl);

    expect(inspireFetch).toHaveBeenCalledTimes(1);
  });

  it('keeps has_more=false when returning cached last-page results', async () => {
    inspireFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        hits: { total: 2, hits: [makeHit(2)] },
        links: {},
      }),
    } as any);

    const first = await api.search('x', { size: 1, page: 2 });
    expect(first.has_more).toBe(false);
    expect(first.next_url).toBeUndefined();

    const second = await api.search('x', { size: 1, page: 2 });
    expect(second.has_more).toBe(false);
    expect(second.next_url).toBeUndefined();

    expect(inspireFetch).toHaveBeenCalledTimes(1);
  });
});

