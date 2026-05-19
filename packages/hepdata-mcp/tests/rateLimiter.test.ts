import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('HEPData rate limiter', () => {
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

  it('retries 429 responses and succeeds on a later attempt', async () => {
    fetchSpy
      .mockResolvedValueOnce(
        new Response('', {
          status: 429,
          headers: { 'retry-after': 'Tue, 31 Dec 2099 00:00:00 GMT' },
        }),
      )
      .mockResolvedValueOnce(new Response('{}', { status: 200 }));

    const { hepdataFetch } = await import('../src/api/rateLimiter.js');
    const response = await hepdataFetch('/search/?q=test');

    expect(response.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('surfaces retryAfterMs on terminal 429 errors', async () => {
    fetchSpy.mockResolvedValue(
      new Response('', {
        status: 429,
        headers: { 'retry-after': '6' },
      }),
    );

    const { hepdataFetch } = await import('../src/api/rateLimiter.js');

    await expect(hepdataFetch('/search/?q=test')).rejects.toMatchObject({
      code: 'RATE_LIMIT',
      retryAfterMs: 6000,
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// B-3 regression — redirect Location must be scheme- and host-validated
// Source of bug: rateLimiter.ts:54 used `redirect: 'follow'`, letting Node
// fetch follow up to 20 redirects to any host. A compromised/malicious
// upstream OR DNS rebinding could redirect to http://169.254.169.254/...
// (AWS metadata), file://, internal services, etc.
//
// Defense:
//   1. `redirect: 'manual'`
//   2. MAX_REDIRECTS = 5 cap
//   3. validateHepdataRedirectTarget: parse URL → reject non-https → require
//      hostname === 'www.hepdata.net'
// ─────────────────────────────────────────────────────────────────────────────
describe('B-3 regression — redirect Location is scheme/host-validated', () => {
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

  it('rejects redirect to http:// scheme (downgrade)', async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(null, {
        status: 302,
        headers: { location: 'http://www.hepdata.net/record/123' },
      }),
    );

    const { hepdataFetch } = await import('../src/api/rateLimiter.js');

    await expect(hepdataFetch('/record/123')).rejects.toThrow(/non-https scheme/);
    expect(fetchSpy.mock.calls).toHaveLength(1);
  });

  it('rejects redirect to file:// scheme', async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(null, {
        status: 302,
        headers: { location: 'file:///etc/passwd' },
      }),
    );

    const { hepdataFetch } = await import('../src/api/rateLimiter.js');

    await expect(hepdataFetch('/record/123')).rejects.toThrow(/non-https scheme/);
    expect(fetchSpy.mock.calls).toHaveLength(1);
  });

  it('rejects redirect to AWS metadata service (host not in allow-list)', async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(null, {
        status: 302,
        headers: { location: 'https://169.254.169.254/latest/meta-data/iam/security-credentials/' },
      }),
    );

    const { hepdataFetch } = await import('../src/api/rateLimiter.js');

    await expect(hepdataFetch('/record/123')).rejects.toThrow(/host not in allow-list/);
    expect(fetchSpy.mock.calls).toHaveLength(1);
  });

  it('rejects redirect to attacker-controlled host', async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(null, {
        status: 302,
        headers: { location: 'https://evil.example.com/leak?token=abc' },
      }),
    );

    const { hepdataFetch } = await import('../src/api/rateLimiter.js');

    await expect(hepdataFetch('/record/123')).rejects.toThrow(/host not in allow-list/);
    expect(fetchSpy.mock.calls).toHaveLength(1);
  });

  it('rejects redirect to a sibling hepdata subdomain (only www.hepdata.net allowed)', async () => {
    // hepdata.net (bare) and any non-www subdomain are not in the allow-list
    fetchSpy.mockResolvedValueOnce(
      new Response(null, {
        status: 302,
        headers: { location: 'https://hepdata.net/record/123' },
      }),
    );

    const { hepdataFetch } = await import('../src/api/rateLimiter.js');

    await expect(hepdataFetch('/record/123')).rejects.toThrow(/host not in allow-list/);
    expect(fetchSpy.mock.calls).toHaveLength(1);
  });

  it('accepts redirect within www.hepdata.net (canonical record URL)', async () => {
    fetchSpy
      .mockResolvedValueOnce(
        new Response(null, {
          status: 301,
          headers: { location: 'https://www.hepdata.net/record/ins123_canonical' },
        }),
      )
      .mockResolvedValueOnce(new Response('{}', { status: 200 }));

    const { hepdataFetch } = await import('../src/api/rateLimiter.js');

    const response = await hepdataFetch('/record/123');
    expect(response.status).toBe(200);
    expect(fetchSpy.mock.calls).toHaveLength(2);
    expect(fetchSpy.mock.calls[1][0]).toBe('https://www.hepdata.net/record/ins123_canonical');
  });

  it('resolves relative Location against current URL and accepts', async () => {
    fetchSpy
      .mockResolvedValueOnce(
        new Response(null, {
          status: 302,
          headers: { location: '/record/canonical' },
        }),
      )
      .mockResolvedValueOnce(new Response('{}', { status: 200 }));

    const { hepdataFetch } = await import('../src/api/rateLimiter.js');

    const response = await hepdataFetch('/record/123');
    expect(response.status).toBe(200);
    expect(fetchSpy.mock.calls[1][0]).toBe('https://www.hepdata.net/record/canonical');
  });

  it('enforces MAX_REDIRECTS cap (5 hops)', async () => {
    // Chain 6 same-host redirects; the 6th MUST be rejected by the cap
    for (let i = 0; i < 6; i++) {
      fetchSpy.mockResolvedValueOnce(
        new Response(null, {
          status: 302,
          headers: { location: `https://www.hepdata.net/hop/${i + 1}` },
        }),
      );
    }

    const { hepdataFetch } = await import('../src/api/rateLimiter.js');

    await expect(hepdataFetch('/record/123')).rejects.toThrow(/redirect limit \(5\) exceeded/);
    // 1 initial + 5 followed redirects = 6 fetch calls; the 6th response's
    // Location is never followed (cap rejects before recursion)
    expect(fetchSpy.mock.calls).toHaveLength(6);
  });

  it('rejects malformed Location header (unparseable URL)', async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(null, {
        status: 302,
        headers: { location: 'http://[invalid' },
      }),
    );

    const { hepdataFetch } = await import('../src/api/rateLimiter.js');

    await expect(hepdataFetch('/record/123')).rejects.toThrow(/not a parseable URL/);
    expect(fetchSpy.mock.calls).toHaveLength(1);
  });

  it('rejects missing Location header on redirect status', async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(null, { status: 302 /* no location header */ }),
    );

    const { hepdataFetch } = await import('../src/api/rateLimiter.js');

    await expect(hepdataFetch('/record/123')).rejects.toThrow(/redirect missing Location header/);
    expect(fetchSpy.mock.calls).toHaveLength(1);
  });
});
