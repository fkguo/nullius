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

// ─────────────────────────────────────────────────────────────────────────────
// B-1 regression — api_key must never appear in any error message
// Source of bug: rateLimiter.ts:198 used to throw `OpenAlex request timed
// out: ${url}` where url contained `api_key=<secret>` from buildUrl(). The
// dispatcher then serialized that into the tool-result JSON without redaction.
// Two-layer defense:
//   1. rateLimiter.ts strips api_key from url before throwing (primary)
//   2. dispatcher.ts runs redact() on error message (defense-in-depth)
// ─────────────────────────────────────────────────────────────────────────────
describe('B-1 regression — api_key never leaks into error messages', () => {
  const fetchSpy = vi.fn();
  let savedKey: string | undefined;
  let savedMinInterval: string | undefined;
  let savedVitest: string | undefined;
  let savedNodeEnv: string | undefined;

  beforeEach(() => {
    savedKey = process.env.OPENALEX_API_KEY;
    savedMinInterval = process.env.OPENALEX_MIN_INTERVAL_MS;
    savedVitest = process.env.VITEST;
    savedNodeEnv = process.env.NODE_ENV;
    process.env.OPENALEX_API_KEY = 'sk-veryLongSecretApiKeyValue1234567890';
    process.env.OPENALEX_MIN_INTERVAL_MS = '0';
    process.env.VITEST = '1';
    vi.stubGlobal('fetch', fetchSpy);
    vi.resetModules();
  });

  afterEach(() => {
    if (savedKey !== undefined) { process.env.OPENALEX_API_KEY = savedKey; } else { delete process.env.OPENALEX_API_KEY; }
    if (savedMinInterval !== undefined) { process.env.OPENALEX_MIN_INTERVAL_MS = savedMinInterval; } else { delete process.env.OPENALEX_MIN_INTERVAL_MS; }
    if (savedVitest !== undefined) { process.env.VITEST = savedVitest; } else { delete process.env.VITEST; }
    if (savedNodeEnv !== undefined) { process.env.NODE_ENV = savedNodeEnv; } else { delete process.env.NODE_ENV; }
    fetchSpy.mockReset();
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('timeout error message does NOT contain api_key= or the secret value', async () => {
    // Simulate AbortError on fetch (timeout path L196-198 in rateLimiter.ts)
    const abortErr = new Error('aborted');
    abortErr.name = 'AbortError';
    fetchSpy.mockRejectedValue(abortErr);

    const { openalexFetch } = await import('../api/rateLimiter.js');

    let caught: unknown;
    try {
      await openalexFetch('/works?search=quantum');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeDefined();
    const message = (caught as Error).message;
    // Primary defense: stripSecretsFromUrl in rateLimiter.ts
    expect(message).not.toContain('api_key=');
    expect(message).not.toContain('sk-veryLongSecretApiKeyValue1234567890');
    // Sanity: timeout message shape preserved
    expect(message).toMatch(/OpenAlex request timed out/);
  });

  it('dispatcher redact() masks secret values at tool-result boundary (defense-in-depth)', async () => {
    const { redact } = await import('@autoresearch/shared');

    // Case 1: secret with sk- prefix. The first redact pattern (sk- prefix)
    // masks the value to `sk-***`, which also defeats the second pattern's
    // 16-char min match, so the literal text `api_key=***` does not appear.
    // What MUST hold: the raw secret value is gone.
    const sk = 'error at https://api.openalex.org/works?api_key=sk-realSecretValue123456789&q=test';
    expect(redact(sk)).not.toContain('sk-realSecretValue123456789');
    expect(redact(sk)).toContain('sk-***');

    // Case 2: secret without prefix — falls through to the generic
    // `api_key=<16+>` pattern which masks the value to `***`.
    const noPrefix = 'leak: api_key=abcdefghijklmnopqrstuvwxyz123';
    expect(redact(noPrefix)).not.toContain('abcdefghijklmnopqrstuvwxyz123');
    expect(redact(noPrefix)).toContain('api_key=***');
  });

  it('B1.1 — generic fetch error path strips api_key from undici error message', async () => {
    // Reviewer-discovered: undici TypeError for malformed URLs includes the
    // FULL URL (with api_key) in err.message. The catch block's sibling
    // throw at rateLimiter.ts L200-202 interpolates err.message raw, so the
    // secret would leak through without `stripSecretsFromMessage`.
    //
    // Note: `redact()` regex `[a-zA-Z0-9]{16,}` does NOT cover base64-ish
    // secrets containing `_-+/=`, so we cannot rely solely on dispatcher-side
    // redaction. The provider-atom layer MUST strip.
    const evilSecret = 'base64+token_with-special/chars=padding1234';
    const undiciErr = new TypeError(
      `Failed to parse URL from https://api.openalex.org/works?api_key=${evilSecret}&q=test`,
    );
    fetchSpy.mockRejectedValue(undiciErr);

    const { openalexFetch } = await import('../api/rateLimiter.js');

    let caught: unknown;
    try {
      await openalexFetch('/works');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeDefined();
    const message = (caught as Error).message;
    // The raw secret value must not survive
    expect(message).not.toContain(evilSecret);
    // The masked form must be present (proves stripSecretsFromMessage applied)
    expect(message).toContain('api_key=***');
    // Sanity: generic-failure message shape preserved
    expect(message).toMatch(/OpenAlex request failed/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// B-2 regression — redirect Location must be scheme- and host-validated
// Source of bug: rateLimiter.ts:210-212 used to recurse on raw `Location`
// without scheme/host validation. A compromised/malicious upstream OR DNS
// rebinding could redirect to http://169.254.169.254/... (AWS metadata),
// file://, internal services, etc. Pure SSRF reach.
//
// Defense:
//   1. new URL(location, currentUrl) — resolves relative URLs
//   2. protocol must be 'https:'
//   3. hostname must be in {api.openalex.org, content.openalex.org}
// ─────────────────────────────────────────────────────────────────────────────
describe('B-2 regression — redirect Location is scheme/host-validated', () => {
  const fetchSpy = vi.fn();
  let savedMinInterval: string | undefined;
  let savedVitest: string | undefined;

  beforeEach(() => {
    savedMinInterval = process.env.OPENALEX_MIN_INTERVAL_MS;
    savedVitest = process.env.VITEST;
    process.env.OPENALEX_MIN_INTERVAL_MS = '0';
    process.env.VITEST = '1';
    vi.stubGlobal('fetch', fetchSpy);
    vi.resetModules();
  });

  afterEach(() => {
    if (savedMinInterval !== undefined) { process.env.OPENALEX_MIN_INTERVAL_MS = savedMinInterval; } else { delete process.env.OPENALEX_MIN_INTERVAL_MS; }
    if (savedVitest !== undefined) { process.env.VITEST = savedVitest; } else { delete process.env.VITEST; }
    fetchSpy.mockReset();
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('rejects redirect to http:// scheme (downgrade)', async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(null, {
        status: 302,
        headers: { location: 'http://api.openalex.org/works/W123' },
      }),
    );

    const { openalexFetch } = await import('../api/rateLimiter.js');

    await expect(openalexFetch('/works/W123')).rejects.toThrow(/non-https scheme/);
    // Defensive: fetch was called exactly once — no recursion happened
    expect(fetchSpy.mock.calls).toHaveLength(1);
  });

  it('rejects redirect to file:// scheme', async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(null, {
        status: 302,
        headers: { location: 'file:///etc/passwd' },
      }),
    );

    const { openalexFetch } = await import('../api/rateLimiter.js');

    await expect(openalexFetch('/works/W123')).rejects.toThrow(/non-https scheme/);
    expect(fetchSpy.mock.calls).toHaveLength(1);
  });

  it('rejects redirect to AWS metadata service (host not in allow-list)', async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(null, {
        status: 302,
        headers: { location: 'https://169.254.169.254/latest/meta-data/iam/security-credentials/' },
      }),
    );

    const { openalexFetch } = await import('../api/rateLimiter.js');

    await expect(openalexFetch('/works/W123')).rejects.toThrow(/host not in allow-list/);
    expect(fetchSpy.mock.calls).toHaveLength(1);
  });

  it('rejects redirect to attacker-controlled host (host not in allow-list)', async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(null, {
        status: 302,
        headers: { location: 'https://evil.example.com/leak?token=abc' },
      }),
    );

    const { openalexFetch } = await import('../api/rateLimiter.js');

    await expect(openalexFetch('/works/W123')).rejects.toThrow(/host not in allow-list/);
    expect(fetchSpy.mock.calls).toHaveLength(1);
  });

  it('accepts redirect within api.openalex.org (canonical URL change)', async () => {
    fetchSpy
      .mockResolvedValueOnce(
        new Response(null, {
          status: 301,
          headers: { location: 'https://api.openalex.org/works/W123_canonical' },
        }),
      )
      .mockResolvedValueOnce(new Response('{}', { status: 200 }));

    const { openalexFetch } = await import('../api/rateLimiter.js');

    const response = await openalexFetch('/works/W123');
    expect(response.status).toBe(200);
    expect(fetchSpy.mock.calls).toHaveLength(2);
    // Second call went to the redirected URL
    expect(fetchSpy.mock.calls[1][0]).toBe('https://api.openalex.org/works/W123_canonical');
  });

  it('accepts cross-host redirect within OpenAlex (api.openalex.org → content.openalex.org)', async () => {
    fetchSpy
      .mockResolvedValueOnce(
        new Response(null, {
          status: 307,
          headers: { location: 'https://content.openalex.org/pdf/W123.pdf' },
        }),
      )
      .mockResolvedValueOnce(new Response('PDF bytes', { status: 200 }));

    const { openalexFetch } = await import('../api/rateLimiter.js');

    const response = await openalexFetch('/works/W123/download');
    expect(response.status).toBe(200);
    expect(fetchSpy.mock.calls).toHaveLength(2);
    expect(fetchSpy.mock.calls[1][0]).toBe('https://content.openalex.org/pdf/W123.pdf');
  });

  it('rejects malformed Location header (unparseable URL)', async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(null, {
        status: 302,
        // Unclosed IPv6 bracket — definitively throws ERR_INVALID_URL when
        // resolved against any base, so we hit the `not a parseable URL`
        // branch deterministically (no host/scheme bypass via relative
        // resolution).
        headers: { location: 'http://[invalid' },
      }),
    );

    const { openalexFetch } = await import('../api/rateLimiter.js');

    await expect(openalexFetch('/works/W123')).rejects.toThrow(/not a parseable URL/);
    expect(fetchSpy.mock.calls).toHaveLength(1);
  });

  it('resolves relative Location against current URL and validates resolved host', async () => {
    // Relative Location: should resolve against the current url's host
    // (api.openalex.org), which IS in the allow-list — accept.
    fetchSpy
      .mockResolvedValueOnce(
        new Response(null, {
          status: 302,
          headers: { location: '/works/W456' },
        }),
      )
      .mockResolvedValueOnce(new Response('{}', { status: 200 }));

    const { openalexFetch } = await import('../api/rateLimiter.js');

    const response = await openalexFetch('/works/W123');
    expect(response.status).toBe(200);
    // Second call resolved relative path against api.openalex.org
    expect(fetchSpy.mock.calls[1][0]).toBe('https://api.openalex.org/works/W456');
  });
});
