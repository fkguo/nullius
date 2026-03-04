import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('Rate limiter public API', () => {
  afterEach(() => {
    delete process.env.OPENALEX_MAX_COST_USD;
    delete process.env.OPENALEX_MAILTO;
    delete process.env.OPENALEX_API_KEY;
    vi.resetModules();
  });

  it('isBudgetExceeded returns false by default (zero cost accumulated)', async () => {
    const { isBudgetExceeded } = await import('../api/rateLimiter.js');
    expect(isBudgetExceeded()).toBe(false);
  });

  it('getCostSummary returns correct shape', async () => {
    const { getCostSummary } = await import('../api/rateLimiter.js');
    const summary = getCostSummary();
    expect(typeof summary.cumulative_usd).toBe('number');
    expect(summary.cumulative_usd).toBeGreaterThanOrEqual(0);
  });

  it('getResponseMeta returns expected shape', async () => {
    const { getResponseMeta } = await import('../api/rateLimiter.js');
    const meta = getResponseMeta();
    expect(typeof meta.pages_fetched).toBe('number');
    expect(typeof meta.retries).toBe('number');
  });
});

describe('Rate limiter URL construction via openalexFetch', () => {
  // We mock the global fetch to capture outgoing URLs
  const fetchSpy = vi.fn();

  beforeEach(() => {
    vi.stubGlobal('fetch', fetchSpy);
    vi.resetModules();
  });

  afterEach(() => {
    fetchSpy.mockReset();
    vi.unstubAllGlobals();
    delete process.env.OPENALEX_API_KEY;
    delete process.env.OPENALEX_MAILTO;
    vi.resetModules();
  });

  it('does not include api_key when env var not set', async () => {
    delete process.env.OPENALEX_API_KEY;
    delete process.env.OPENALEX_MAILTO;

    fetchSpy.mockResolvedValue(new Response('{"results":[],"meta":{"count":0}}', { status: 200 }));

    const { openalexFetch } = await import('../api/rateLimiter.js');
    await openalexFetch('/works?per-page=1');

    const calledUrl = fetchSpy.mock.calls[0]?.[0] as string;
    expect(calledUrl).not.toContain('api_key=');
  });

  it('includes api_key when OPENALEX_API_KEY is set', async () => {
    process.env.OPENALEX_API_KEY = 'test-key-12345';

    fetchSpy.mockResolvedValue(new Response('{"results":[],"meta":{"count":0}}', { status: 200 }));

    const { openalexFetch } = await import('../api/rateLimiter.js');
    await openalexFetch('/works?per-page=1');

    const calledUrl = fetchSpy.mock.calls[0]?.[0] as string;
    expect(calledUrl).toContain('api_key=test-key-12345');
  });

  it('includes mailto when OPENALEX_MAILTO is set', async () => {
    process.env.OPENALEX_MAILTO = 'test@example.com';

    fetchSpy.mockResolvedValue(new Response('{"results":[],"meta":{"count":0}}', { status: 200 }));

    const { openalexFetch } = await import('../api/rateLimiter.js');
    await openalexFetch('/works?per-page=1');

    const calledUrl = fetchSpy.mock.calls[0]?.[0] as string;
    expect(decodeURIComponent(calledUrl)).toContain('mailto=test@example.com');
  });

  it('constructs correct base URL', async () => {
    fetchSpy.mockResolvedValue(new Response('{"results":[],"meta":{"count":0}}', { status: 200 }));

    const { openalexFetch } = await import('../api/rateLimiter.js');
    await openalexFetch('/works?filter=is_oa:true');

    const calledUrl = fetchSpy.mock.calls[0]?.[0] as string;
    expect(calledUrl).toContain('https://api.openalex.org/works');
    expect(calledUrl).toContain('filter=is_oa');
  });
});
