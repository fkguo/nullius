import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

function makeListResponse(items: Array<{ id: string; [k: string]: unknown }>) {
  return {
    results: items,
    meta: { count: items.length, page: 1, per_page: 25, next_cursor: null },
  };
}

describe('handleBatch entity routing', () => {
  const fetchSpy = vi.fn();

  beforeEach(() => {
    vi.stubGlobal('fetch', fetchSpy);
    vi.resetModules();
  });

  afterEach(() => {
    fetchSpy.mockReset();
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('routes Work IDs (W...) to /works endpoint', async () => {
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify(makeListResponse([{ id: 'https://openalex.org/W123' }])), {
        status: 200,
      }),
    );

    const { handleBatch } = await import('../api/client.js');
    const result = await handleBatch({ ids: ['W123'] });

    const calledUrl = fetchSpy.mock.calls[0]?.[0] as string;
    expect(calledUrl).toContain('/works?');
    expect(result.results[0]?.status).toBe('found');
  });

  it('routes Author IDs (A...) to /authors endpoint', async () => {
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify(makeListResponse([{ id: 'https://openalex.org/A456' }])), {
        status: 200,
      }),
    );

    const { handleBatch } = await import('../api/client.js');
    const result = await handleBatch({ ids: ['A456'] });

    const calledUrl = fetchSpy.mock.calls[0]?.[0] as string;
    expect(calledUrl).toContain('/authors?');
    expect(result.results[0]?.status).toBe('found');
  });

  it('issues separate requests for mixed W and A IDs', async () => {
    fetchSpy
      .mockResolvedValueOnce(
        new Response(JSON.stringify(makeListResponse([{ id: 'https://openalex.org/W123' }])), {
          status: 200,
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify(makeListResponse([{ id: 'https://openalex.org/A456' }])), {
          status: 200,
        }),
      );

    const { handleBatch } = await import('../api/client.js');
    const result = await handleBatch({ ids: ['W123', 'A456'] });

    const calledUrls = fetchSpy.mock.calls.map(c => c[0] as string);
    expect(calledUrls.some(u => u.includes('/works?'))).toBe(true);
    expect(calledUrls.some(u => u.includes('/authors?'))).toBe(true);
    expect(result.results).toHaveLength(2);
    expect(result.results.every(r => r.status === 'found')).toBe(true);
  });

  it('does not match W1 to W10 or W100 — exact path-segment comparison', async () => {
    // Response contains W10 and W100 but NOT W1 — W1 must be not_found
    fetchSpy.mockResolvedValue(
      new Response(
        JSON.stringify(
          makeListResponse([
            { id: 'https://openalex.org/W10' },
            { id: 'https://openalex.org/W100' },
          ]),
        ),
        { status: 200 },
      ),
    );

    const { handleBatch } = await import('../api/client.js');
    const result = await handleBatch({ ids: ['W1'] });

    expect(result.results[0]?.status).toBe('not_found');
  });

  it('correctly finds W1 when W10 and W100 are also in the response', async () => {
    fetchSpy.mockResolvedValue(
      new Response(
        JSON.stringify(
          makeListResponse([
            { id: 'https://openalex.org/W10' },
            { id: 'https://openalex.org/W1' },
            { id: 'https://openalex.org/W100' },
          ]),
        ),
        { status: 200 },
      ),
    );

    const { handleBatch } = await import('../api/client.js');
    const result = await handleBatch({ ids: ['W1'] });

    expect(result.results[0]?.status).toBe('found');
  });
});
