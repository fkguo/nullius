import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserSolver } from '../src/api/transport/browserTransport.js';
import { UrlCache } from '../src/api/transport/urlCache.js';

// ─────────────────────────────────────────────────────────────────────────────
// End-to-end wiring of the Cloudflare browser-fallback + URL cache into the
// HEPData rate limiter (rateLimiter.ts `fetchWithRetry`).
//
// IMPORTANT: rateLimiter.ts imports getUrlCache/selectAndRun from
// browserTransport.js. Each test re-imports the module graph after
// vi.resetModules(), so we must grab the setters from the SAME freshly-imported
// browserTransport module instance (not a stale top-level import) for injection
// to reach the limiter. `loadFresh()` does exactly that.
// ─────────────────────────────────────────────────────────────────────────────

const CHALLENGE_BODY =
  '<html><head><title>Just a moment...</title></head><body>' +
  '<div id="challenge-platform"></div>Enable JavaScript and cookies to continue</body></html>';

function challengeResponse(): Response {
  return new Response(CHALLENGE_BODY, {
    status: 403,
    headers: { 'cf-mitigated': 'challenge', server: 'cloudflare', 'cf-ray': 'ray-xyz' },
  });
}

async function loadFresh() {
  const transport = await import('../src/api/transport/browserTransport.js');
  const limiter = await import('../src/api/rateLimiter.js');
  return { transport, limiter };
}

const fetchSpy = vi.fn();
const ENV_KEYS = ['HEPDATA_BROWSER_FETCH', 'HEPDATA_PROXY', 'HTTPS_PROXY', 'https_proxy'] as const;
let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  vi.stubGlobal('fetch', fetchSpy);
  vi.resetModules();
  savedEnv = {};
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  fetchSpy.mockReset();
  vi.unstubAllGlobals();
  vi.resetModules();
  for (const k of ENV_KEYS) {
    if (savedEnv[k] !== undefined) process.env[k] = savedEnv[k];
    else delete process.env[k];
  }
});

describe('rateLimiter — contact-honest User-Agent on the plain path', () => {
  it('sets a hep-mcp User-Agent identifying the client + repo when none provided', async () => {
    fetchSpy.mockResolvedValueOnce(new Response('{}', { status: 200 }));
    const { limiter } = await loadFresh();

    await limiter.hepdataFetch('/search/?q=x');

    const init = fetchSpy.mock.calls[0][1] as RequestInit;
    const headers = new Headers(init.headers);
    expect(headers.get('user-agent')).toMatch(/^hep-mcp\/\d/);
    expect(headers.get('user-agent')).toContain('autoresearch-lab');
    // Honest identification — NOT a spoofed browser UA on the plain path.
    expect(headers.get('user-agent')).not.toMatch(/Mozilla|Chrome|Safari/);
  });

  it('does not overwrite a caller-provided User-Agent', async () => {
    fetchSpy.mockResolvedValueOnce(new Response('{}', { status: 200 }));
    const { limiter } = await loadFresh();

    await limiter.hepdataFetch('/search/?q=x', { headers: { 'User-Agent': 'caller/9.9' } });

    const init = fetchSpy.mock.calls[0][1] as RequestInit;
    expect(new Headers(init.headers).get('user-agent')).toBe('caller/9.9');
  });
});

describe('rateLimiter — non-challenge body is reconstructed (downstream .json() works)', () => {
  it('a normal 200 JSON response survives the read-once + reconstruct round-trip', async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ total: 2 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const { limiter } = await loadFresh();

    const res = await limiter.hepdataFetch('/search/?q=x');
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ total: 2 });
  });

  it('a non-2xx non-challenge response (404) is returned, not cached', async () => {
    fetchSpy.mockResolvedValue(new Response('not found', { status: 404 }));
    const { transport, limiter } = await loadFresh();
    const cache = new UrlCache(8);
    transport.setUrlCache(cache);

    const res = await limiter.hepdataFetch('/record/999?format=json');
    expect(res.status).toBe(404);
    await expect(res.text()).resolves.toBe('not found');
    expect(cache.size).toBe(0);
  });
});

describe('rateLimiter — successful GET is cached and short-circuits the next call', () => {
  it('second identical GET is served from cache (fetch called once)', async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const { transport, limiter } = await loadFresh();
    transport.setUrlCache(new UrlCache(8));

    const first = await limiter.hepdataFetch('/record/1?format=json');
    await expect(first.json()).resolves.toEqual({ ok: true });

    // No second fetch is queued; the cache must satisfy the repeat.
    const second = await limiter.hepdataFetch('/record/1?format=json');
    await expect(second.json()).resolves.toEqual({ ok: true });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('a binary 200 download (ZIP) is returned with bytes intact and is NOT cached', async () => {
    // A ZIP signature ("PK\x03\x04") plus bytes that are NOT valid UTF-8 — if the
    // limiter round-tripped this through `.text()` it would be corrupted, and the
    // download path (client.downloadSubmission → .arrayBuffer()) would break.
    const zipBytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0xff, 0xfe, 0x00, 0x80, 0x81]);
    fetchSpy.mockResolvedValueOnce(
      new Response(zipBytes, {
        status: 200,
        headers: { 'content-type': 'application/zip' },
      }),
    );
    const { transport, limiter } = await loadFresh();
    const cache = new UrlCache(8);
    transport.setUrlCache(cache);

    const res = await limiter.hepdataFetch('/download/submission/1/original');
    const out = new Uint8Array(await res.arrayBuffer());
    expect(Array.from(out)).toEqual(Array.from(zipBytes));
    expect(cache.size).toBe(0); // binary content type → not cached
  });

  it('a 200 with NO content-type header is returned but NOT cached (conservative)', async () => {
    // Build a Response whose body does not auto-attach a content-type. (Passing a
    // string to `new Response` auto-sets text/plain; an untyped Blob does not.)
    const makeResp = () => {
      const r = new Response(new Blob([JSON.stringify({ a: 1 })]), { status: 200 });
      r.headers.delete('content-type');
      return r;
    };
    expect(makeResp().headers.get('content-type')).toBeNull();
    fetchSpy.mockImplementation(async () => makeResp());

    const { transport, limiter } = await loadFresh();
    const cache = new UrlCache(8);
    transport.setUrlCache(cache);

    const first = await limiter.hepdataFetch('/record/7?format=json');
    await expect(first.json()).resolves.toEqual({ a: 1 });
    expect(cache.size).toBe(0);

    // Not cached → a second call re-fetches.
    await limiter.hepdataFetch('/record/7?format=json');
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('a non-GET request is never served from cache', async () => {
    fetchSpy
      .mockResolvedValueOnce(new Response('{}', { status: 200 }))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }));
    const { transport, limiter } = await loadFresh();
    transport.setUrlCache(new UrlCache(8));

    await limiter.hepdataFetch('/record/1?format=json', { method: 'POST' });
    await limiter.hepdataFetch('/record/1?format=json', { method: 'POST' });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });
});

describe('rateLimiter — Cloudflare challenge handling', () => {
  it('challenge + opt-OUT (default) → throws the precise actionable error with cf-ray', async () => {
    // Persistent mock: each call (including any retry path) sees a challenge.
    fetchSpy.mockResolvedValue(challengeResponse());
    const { limiter } = await loadFresh();

    const err = await limiter.hepdataFetch('/record/123?format=json').then(
      () => {
        throw new Error('expected hepdataFetch to reject on an unsolved challenge');
      },
      (e: unknown) => e,
    );

    expect(err).toMatchObject({ code: 'UPSTREAM_ERROR' });
    expect((err as Error).message).toMatch(
      /Cloudflare Managed Challenge[\s\S]*cf-ray: ray-xyz[\s\S]*HEPDATA_BROWSER_FETCH=1[\s\S]*npm i playwright/,
    );
  });

  it('challenge + opt-IN → injected mock solver produces a synthetic 200 the caller can .json()', async () => {
    process.env.HEPDATA_BROWSER_FETCH = '1';
    fetchSpy.mockResolvedValueOnce(challengeResponse());

    const { transport, limiter } = await loadFresh();
    const solver: BrowserSolver = {
      async solve() {
        return {
          status: 200,
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ recid: 123, record: {} }),
        };
      },
    };
    transport.setBrowserSolver(solver);
    transport.setUrlCache(new UrlCache(8));

    const res = await limiter.hepdataFetch('/record/123?format=json');
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ recid: 123 });
  });

  it('challenge + opt-IN: a solver-solved 2xx GET is cached (browser path stays rare)', async () => {
    process.env.HEPDATA_BROWSER_FETCH = '1';
    fetchSpy.mockResolvedValueOnce(challengeResponse());

    const { transport, limiter } = await loadFresh();
    const cache = new UrlCache(8);
    transport.setUrlCache(cache);
    let solveCount = 0;
    transport.setBrowserSolver({
      async solve() {
        solveCount += 1;
        return { status: 200, headers: {}, body: '{"v":1}' };
      },
    });

    await limiter.hepdataFetch('/record/123?format=json');
    // Second call: cache hit, no new fetch, no new solve.
    const again = await limiter.hepdataFetch('/record/123?format=json');
    await expect(again.json()).resolves.toEqual({ v: 1 });

    expect(solveCount).toBe(1);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('challenge + opt-IN + playwright absent → precise "npm i playwright" error', async () => {
    process.env.HEPDATA_BROWSER_FETCH = '1';
    fetchSpy.mockResolvedValueOnce(challengeResponse());

    const { transport, limiter } = await loadFresh();
    // Real PlaywrightSolver, but force the dynamic import to fail.
    transport.setBrowserSolver(new transport.PlaywrightSolver());
    transport.setPlaywrightImporter(async () => {
      throw new Error("Cannot find module 'playwright'");
    });

    await expect(limiter.hepdataFetch('/record/123?format=json')).rejects.toThrow(
      /npm i playwright/,
    );
  });
});
