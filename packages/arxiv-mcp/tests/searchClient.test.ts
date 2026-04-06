import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { searchArxiv } from '../src/api/searchClient.js';

const EMPTY_FEED = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<feed xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/">',
  '<opensearch:totalResults>0</opensearch:totalResults>',
  '<opensearch:startIndex>0</opensearch:startIndex>',
  '</feed>',
].join('');

function getSearchQueryArg(fetchCallArg: unknown): string {
  const url = new URL(String(fetchCallArg));
  return decodeURIComponent(url.searchParams.get('search_query') ?? '');
}

describe('searchArxiv hardening', () => {
  const fetchSpy = vi.fn();

  beforeEach(() => {
    vi.stubGlobal('fetch', fetchSpy);
  });

  afterEach(() => {
    fetchSpy.mockReset();
    vi.unstubAllGlobals();
  });

  it('normalizes ISO-like date filters to YYYYMMDD query syntax', async () => {
    fetchSpy.mockResolvedValueOnce(new Response(EMPTY_FEED, { status: 200 }));

    await searchArxiv({
      query: 'all:agent',
      categories: ['cs.AI'],
      date_from: '2024-01-01',
      date_to: '2024/12/31',
      max_results: 5,
    });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const searchQuery = getSearchQueryArg(fetchSpy.mock.calls[0][0]);
    expect(searchQuery).toContain('submittedDate:[20240101 TO 20241231]');
  });

  it('omits malformed date filters that cannot be normalized safely', async () => {
    fetchSpy.mockResolvedValueOnce(new Response(EMPTY_FEED, { status: 200 }));

    await searchArxiv({
      query: 'all:benchmark',
      categories: ['cs.LG'],
      date_from: 'from-yesterday',
      date_to: 'tomorrow',
      max_results: 5,
    });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const searchQuery = getSearchQueryArg(fetchSpy.mock.calls[0][0]);
    expect(searchQuery).not.toContain('submittedDate:[');
  });

  it('probes once without date filter but fails closed when date-constrained query gets a 5xx', async () => {
    fetchSpy
      .mockResolvedValueOnce(new Response('upstream fail', { status: 500, statusText: 'Internal Server Error' }))
      .mockResolvedValueOnce(new Response(EMPTY_FEED, { status: 200 }));

    await expect(searchArxiv({
      query: 'all:agent',
      categories: ['cs.AI'],
      date_from: '20240101',
      date_to: '20241231',
      max_results: 5,
    })).rejects.toThrow('arXiv API could not satisfy the requested date-constrained search');
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const firstQuery = getSearchQueryArg(fetchSpy.mock.calls[0][0]);
    const secondQuery = getSearchQueryArg(fetchSpy.mock.calls[1][0]);
    expect(firstQuery).toContain('submittedDate:[20240101 TO 20241231]');
    expect(secondQuery).not.toContain('submittedDate:[');
  });

  it('does not retry 5xx errors when no date filter is present', async () => {
    fetchSpy.mockResolvedValueOnce(new Response('upstream fail', { status: 500, statusText: 'Internal Server Error' }));

    await expect(searchArxiv({
      query: 'all:agent',
      categories: ['cs.AI'],
      max_results: 5,
    })).rejects.toThrow('arXiv API error: 500 Internal Server Error');

    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});
