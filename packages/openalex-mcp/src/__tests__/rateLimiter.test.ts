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

  it('surfaces retryAfterMs on terminal 429 errors', async () => {
    fetchSpy.mockResolvedValue(
      new Response('{}', {
        status: 429,
        headers: { 'retry-after': '7' },
      }),
    );

    const { openalexFetch } = await import('../api/rateLimiter.js');

    await expect(openalexFetch('/works?per-page=1')).rejects.toMatchObject({
      code: 'RATE_LIMIT',
      retryAfterMs: 7000,
    });
  });
});

describe('withSlot queue/release semantics', () => {
  // These tests disable the isTestEnv() bypass so the real slot logic runs.
  const fetchSpy = vi.fn();
  let savedVitest: string | undefined;
  let savedNodeEnv: string | undefined;

  beforeEach(() => {
    vi.stubGlobal('fetch', fetchSpy);
    vi.resetModules();
    // Temporarily defeat isTestEnv() so withSlot runs real serialization logic
    savedVitest = process.env.VITEST;
    savedNodeEnv = process.env.NODE_ENV;
    delete process.env.VITEST;
    process.env.NODE_ENV = 'production';
    // Skip interval delays so tests run immediately
    process.env.OPENALEX_MIN_INTERVAL_MS = '0';
  });

  afterEach(() => {
    if (savedVitest !== undefined) { process.env.VITEST = savedVitest; } else { delete process.env.VITEST; }
    if (savedNodeEnv !== undefined) { process.env.NODE_ENV = savedNodeEnv; } else { delete process.env.NODE_ENV; }
    delete process.env.OPENALEX_MIN_INTERVAL_MS;
    fetchSpy.mockReset();
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('releases slot after fn() error — subsequent request is not blocked', async () => {
    // First call: fetch throws a network error
    fetchSpy.mockRejectedValueOnce(new TypeError('network failure'));
    // Second call: succeeds
    fetchSpy.mockResolvedValueOnce(new Response('{}', { status: 200 }));

    const { openalexFetch } = await import('../api/rateLimiter.js');

    // First call fails
    await expect(openalexFetch('/works')).rejects.toThrow();

    // Slot was released in finally — second call proceeds without deadlock
    const response = await openalexFetch('/works');
    expect(response.status).toBe(200);
  });

  it('serializes concurrent callers — second fetch starts only after first completes', async () => {
    let firstFetchDone = false;

    fetchSpy
      .mockImplementationOnce(
        () =>
          new Promise<Response>(resolve =>
            setTimeout(() => {
              firstFetchDone = true;
              resolve(new Response('{}', { status: 200 }));
            }, 10),
          ),
      )
      .mockImplementationOnce(async () => {
        // withSlot guarantees this runs after the first fetch's slot is released
        expect(firstFetchDone).toBe(true);
        return new Response('{}', { status: 200 });
      });

    const { openalexFetch } = await import('../api/rateLimiter.js');

    await Promise.all([openalexFetch('/works?q=1'), openalexFetch('/works?q=2')]);
    expect(fetchSpy.mock.calls).toHaveLength(2);
  });
});
