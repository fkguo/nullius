import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type BrowserSolveOptions,
  type BrowserSolveResult,
  type BrowserSolver,
  browserFetchEnabled,
  challengeOptOutError,
  PlaywrightSolver,
  PlaywrightUnavailableError,
  resolveProxy,
  selectAndRun,
  setBrowserSolver,
  setPlaywrightImporter,
  setUrlCache,
} from '../src/api/transport/browserTransport.js';
import { UrlCache } from '../src/api/transport/urlCache.js';

const URL = 'https://www.hepdata.net/record/123?format=json';

// A mock solver that records its inputs and returns a canned result.
function mockSolver(result: BrowserSolveResult): { solver: BrowserSolver; calls: Array<{ url: string; opts: BrowserSolveOptions }> } {
  const calls: Array<{ url: string; opts: BrowserSolveOptions }> = [];
  const solver: BrowserSolver = {
    async solve(url, opts) {
      calls.push({ url, opts });
      return result;
    },
  };
  return { solver, calls };
}

// Snapshot + restore the env vars these tests mutate.
const ENV_KEYS = ['HEPDATA_BROWSER_FETCH', 'HEPDATA_PROXY', 'HTTPS_PROXY', 'https_proxy'] as const;
let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  savedEnv = {};
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  setUrlCache(new UrlCache(8));
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] !== undefined) process.env[k] = savedEnv[k];
    else delete process.env[k];
  }
  setBrowserSolver(); // restore PlaywrightSolver
  setUrlCache(); // restore default cache
  setPlaywrightImporter(); // restore real importer
  vi.restoreAllMocks();
});

describe('browserFetchEnabled — opt-in parsing', () => {
  it('is false when unset', () => {
    expect(browserFetchEnabled()).toBe(false);
  });

  it.each(['1', 'true', 'yes', 'on', 'TRUE'])('is true for %s', (v) => {
    process.env.HEPDATA_BROWSER_FETCH = v;
    expect(browserFetchEnabled()).toBe(true);
  });

  it.each(['0', 'false', 'no', 'off', '', '  '])('is false for falsey %j', (v) => {
    process.env.HEPDATA_BROWSER_FETCH = v;
    expect(browserFetchEnabled()).toBe(false);
  });
});

describe('resolveProxy — env precedence', () => {
  it('returns undefined when no proxy env is set', () => {
    expect(resolveProxy()).toBeUndefined();
  });

  it('prefers HEPDATA_PROXY over HTTPS_PROXY and https_proxy', () => {
    process.env.HEPDATA_PROXY = 'http://hep:1';
    process.env.HTTPS_PROXY = 'http://upper:2';
    process.env.https_proxy = 'http://lower:3';
    expect(resolveProxy()).toBe('http://hep:1');
  });

  it('falls back to HTTPS_PROXY then https_proxy', () => {
    process.env.HTTPS_PROXY = 'http://upper:2';
    process.env.https_proxy = 'http://lower:3';
    expect(resolveProxy()).toBe('http://upper:2');

    delete process.env.HTTPS_PROXY;
    expect(resolveProxy()).toBe('http://lower:3');
  });

  it('treats whitespace-only as unset', () => {
    process.env.HEPDATA_PROXY = '   ';
    expect(resolveProxy()).toBeUndefined();
  });
});

describe('challengeOptOutError — precise actionable message', () => {
  it('names the challenge, includes cf-ray, and lists all three remedies', () => {
    const headers = new Headers({ 'cf-ray': 'abc123-LHR' });
    const err = challengeOptOutError(URL, headers);
    const msg = (err as Error).message;

    expect(msg).toMatch(/Cloudflare Managed Challenge/i);
    expect(msg).toContain('cf-ray: abc123-LHR');
    expect(msg).toContain(URL);
    // Remedy (a) clean proxy, (b) browser fallback + playwright, (c) clean exit.
    expect(msg).toMatch(/HEPDATA_PROXY|residential proxy/i);
    expect(msg).toMatch(/HEPDATA_BROWSER_FETCH=1/);
    expect(msg).toMatch(/npm i playwright/);
    expect(msg).toMatch(/clean exit IP/i);
  });

  it('omits the cf-ray clause when the header is absent', () => {
    const err = challengeOptOutError(URL, new Headers());
    expect((err as Error).message).not.toContain('cf-ray');
  });
});

describe('selectAndRun — transport selection policy', () => {
  it('challenge + opt-OUT → throws the precise opt-out error; never calls a solver', async () => {
    const { solver, calls } = mockSolver({ status: 200, headers: {}, body: '{}' });
    setBrowserSolver(solver);
    // HEPDATA_BROWSER_FETCH is unset (opt-out)

    await expect(selectAndRun(URL, new Headers({ 'cf-ray': 'r1' }))).rejects.toThrow(
      /Cloudflare Managed Challenge/i,
    );
    expect(calls).toHaveLength(0);
  });

  it('challenge + opt-IN → runs the mock solver and returns its result', async () => {
    process.env.HEPDATA_BROWSER_FETCH = '1';
    const { solver, calls } = mockSolver({
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: '{"total":1}',
    });
    setBrowserSolver(solver);

    const result = await selectAndRun(URL, new Headers());
    expect(result.status).toBe(200);
    expect(result.body).toBe('{"total":1}');
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(URL);
  });

  it('challenge + opt-IN passes the resolved proxy + confined userDataDir to the solver', async () => {
    process.env.HEPDATA_BROWSER_FETCH = '1';
    process.env.HEPDATA_PROXY = 'http://127.0.0.1:7890';
    const { solver, calls } = mockSolver({ status: 200, headers: {}, body: '{}' });
    setBrowserSolver(solver);

    await selectAndRun(URL, new Headers());
    expect(calls[0].opts.proxy).toBe('http://127.0.0.1:7890');
    expect(calls[0].opts.userDataDir).toMatch(/hep-mcp-cf-profile$/);
    expect(calls[0].opts.timeoutMs).toBeGreaterThan(0);
  });

  it('challenge + opt-IN caches a 2xx result so a later cache lookup hits', async () => {
    process.env.HEPDATA_BROWSER_FETCH = '1';
    const cache = new UrlCache(8);
    setUrlCache(cache);
    const { solver } = mockSolver({ status: 200, headers: { server: 'cloudflare' }, body: 'OK' });
    setBrowserSolver(solver);

    await selectAndRun(URL, new Headers());
    expect(cache.get(URL)).toEqual({ status: 200, headers: { server: 'cloudflare' }, body: 'OK' });
  });

  it('challenge + opt-IN does NOT cache a non-2xx solver result', async () => {
    process.env.HEPDATA_BROWSER_FETCH = '1';
    const cache = new UrlCache(8);
    setUrlCache(cache);
    const { solver } = mockSolver({ status: 500, headers: {}, body: 'err' });
    setBrowserSolver(solver);

    await selectAndRun(URL, new Headers());
    expect(cache.has(URL)).toBe(false);
  });

  it('challenge + opt-IN + playwright import FAILS → precise "npm i playwright" error', async () => {
    process.env.HEPDATA_BROWSER_FETCH = '1';
    // Use the REAL PlaywrightSolver but force its dynamic import to fail.
    setBrowserSolver(new PlaywrightSolver());
    setPlaywrightImporter(async () => {
      throw new Error("Cannot find module 'playwright'");
    });

    await expect(selectAndRun(URL, new Headers())).rejects.toThrow(/npm i playwright/);
  });

  it('wraps an unexpected solver error in an upstream error mentioning the URL', async () => {
    process.env.HEPDATA_BROWSER_FETCH = '1';
    setBrowserSolver({
      async solve() {
        throw new Error('chromium crashed');
      },
    });

    await expect(selectAndRun(URL, new Headers())).rejects.toThrow(/chromium crashed/);
    await expect(selectAndRun(URL, new Headers())).rejects.toThrow(/Browser transport failed/);
  });
});

describe('PlaywrightSolver — host assertion (no real browser launched)', () => {
  it('rejects a non-hepdata host before importing playwright', async () => {
    const solver = new PlaywrightSolver();
    // Importer would throw if reached; host assert must fire first.
    setPlaywrightImporter(async () => {
      throw new Error('import should not be reached');
    });
    await expect(
      solver.solve('https://evil.example.com/x', {
        userDataDir: '/tmp/x',
        timeoutMs: 1000,
      }),
    ).rejects.toThrow(/host not in allow-list/);
  });

  it('rejects an http:// (non-https) hepdata URL', async () => {
    const solver = new PlaywrightSolver();
    await expect(
      solver.solve('http://www.hepdata.net/x', { userDataDir: '/tmp/x', timeoutMs: 1000 }),
    ).rejects.toThrow(/non-https scheme/);
  });

  it('surfaces PlaywrightUnavailableError when the import fails for a valid host', async () => {
    const solver = new PlaywrightSolver();
    setPlaywrightImporter(async () => {
      throw new Error("Cannot find module 'playwright'");
    });
    await expect(
      solver.solve(URL, { userDataDir: '/tmp/x', timeoutMs: 1000 }),
    ).rejects.toBeInstanceOf(PlaywrightUnavailableError);
  });
});
