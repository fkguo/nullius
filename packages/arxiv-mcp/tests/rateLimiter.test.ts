import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('arXiv rate limiter retry behavior', () => {
  const fetchSpy = vi.fn();

  function fetchFailedWithCause(code: string, message: string): TypeError {
    const cause = Object.assign(new Error(message), { code });
    return Object.assign(new TypeError('fetch failed'), { cause });
  }

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

    const { arxivFetch } = await import('../src/api/rateLimiter.js');
    const response = await arxivFetch('https://export.arxiv.org/api/query?max_results=1');

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

    const { arxivFetch } = await import('../src/api/rateLimiter.js');

    await expect(arxivFetch('https://export.arxiv.org/api/query?max_results=1')).rejects.toMatchObject({
      code: 'RATE_LIMIT',
      retryAfterMs: 6000,
    });
  });

  it('retries transient fetch failures and succeeds on a later attempt', async () => {
    fetchSpy
      .mockRejectedValueOnce(fetchFailedWithCause('ETIMEDOUT', 'connect ETIMEDOUT 203.0.113.7:443'))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }));

    const { arxivFetch } = await import('../src/api/rateLimiter.js');
    const response = await arxivFetch('https://export.arxiv.org/api/query?max_results=1');

    expect(response.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('surfaces the fetch failure cause after network retries are exhausted', async () => {
    fetchSpy.mockRejectedValue(fetchFailedWithCause('UND_ERR_CONNECT_TIMEOUT', 'Connect Timeout Error'));

    const { arxivFetch } = await import('../src/api/rateLimiter.js');

    await expect(arxivFetch('https://export.arxiv.org/api/query?max_results=1')).rejects.toMatchObject({
      code: 'UPSTREAM_ERROR',
      message: 'arXiv request failed: fetch failed (cause: Connect Timeout Error)',
      data: {
        code: 'UND_ERR_CONNECT_TIMEOUT',
        cause: 'Connect Timeout Error',
        attempts: 4,
      },
    });
    expect(fetchSpy).toHaveBeenCalledTimes(4);
  });
});

describe('arXiv rate limiter interval gating', () => {
  const fetchSpy = vi.fn();
  let savedVitest: string | undefined;
  let savedVitestWorkerId: string | undefined;
  let savedVitestPoolId: string | undefined;
  let savedNodeEnv: string | undefined;
  let savedArxivDataDir: string | undefined;
  let dataDir: string;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-24T03:00:04Z'));
    vi.stubGlobal('fetch', fetchSpy);
    vi.resetModules();
    savedVitest = process.env.VITEST;
    savedVitestWorkerId = process.env.VITEST_WORKER_ID;
    savedVitestPoolId = process.env.VITEST_POOL_ID;
    savedNodeEnv = process.env.NODE_ENV;
    savedArxivDataDir = process.env.ARXIV_DATA_DIR;
    delete process.env.VITEST;
    delete process.env.VITEST_WORKER_ID;
    delete process.env.VITEST_POOL_ID;
    process.env.NODE_ENV = 'production';
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'arxiv-interval-rate-limit-'));
    process.env.ARXIV_DATA_DIR = dataDir;
  });

  afterEach(() => {
    vi.useRealTimers();
    if (savedVitest !== undefined) process.env.VITEST = savedVitest;
    else delete process.env.VITEST;
    if (savedVitestWorkerId !== undefined) process.env.VITEST_WORKER_ID = savedVitestWorkerId;
    else delete process.env.VITEST_WORKER_ID;
    if (savedVitestPoolId !== undefined) process.env.VITEST_POOL_ID = savedVitestPoolId;
    else delete process.env.VITEST_POOL_ID;
    if (savedNodeEnv !== undefined) process.env.NODE_ENV = savedNodeEnv;
    else delete process.env.NODE_ENV;
    if (savedArxivDataDir !== undefined) process.env.ARXIV_DATA_DIR = savedArxivDataDir;
    else delete process.env.ARXIV_DATA_DIR;
    if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
    fetchSpy.mockReset();
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('enforces the 3 second interval between requests', async () => {
    const calledAt: number[] = [];
    fetchSpy.mockImplementation(async () => {
      calledAt.push(Date.now());
      return new Response('{}', { status: 200 });
    });

    const { arxivFetch } = await import('../src/api/rateLimiter.js');

    const first = arxivFetch('https://export.arxiv.org/api/query?max_results=1');
    await first;

    const second = arxivFetch('https://export.arxiv.org/api/query?max_results=2');
    await vi.advanceTimersByTimeAsync(3000);
    await second;

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(calledAt[1] - calledAt[0]).toBe(3000);
  });
});

describe('arXiv rate limiter shared interval gating', () => {
  const fetchSpy = vi.fn();
  let savedVitest: string | undefined;
  let savedVitestWorkerId: string | undefined;
  let savedVitestPoolId: string | undefined;
  let savedNodeEnv: string | undefined;
  let savedArxivDataDir: string | undefined;
  let dataDir: string;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-24T03:00:04Z'));
    vi.stubGlobal('fetch', fetchSpy);
    vi.resetModules();
    savedVitest = process.env.VITEST;
    savedVitestWorkerId = process.env.VITEST_WORKER_ID;
    savedVitestPoolId = process.env.VITEST_POOL_ID;
    savedNodeEnv = process.env.NODE_ENV;
    savedArxivDataDir = process.env.ARXIV_DATA_DIR;
    delete process.env.VITEST;
    delete process.env.VITEST_WORKER_ID;
    delete process.env.VITEST_POOL_ID;
    process.env.NODE_ENV = 'production';
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'arxiv-shared-rate-limit-'));
    process.env.ARXIV_DATA_DIR = dataDir;
    const stateDir = path.join(dataDir, 'rate-limit');
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'api-query.last-acquire-ms'), String(Date.now()), 'utf-8');
  });

  afterEach(() => {
    vi.useRealTimers();
    if (savedVitest !== undefined) process.env.VITEST = savedVitest;
    else delete process.env.VITEST;
    if (savedVitestWorkerId !== undefined) process.env.VITEST_WORKER_ID = savedVitestWorkerId;
    else delete process.env.VITEST_WORKER_ID;
    if (savedVitestPoolId !== undefined) process.env.VITEST_POOL_ID = savedVitestPoolId;
    else delete process.env.VITEST_POOL_ID;
    if (savedNodeEnv !== undefined) process.env.NODE_ENV = savedNodeEnv;
    else delete process.env.NODE_ENV;
    if (savedArxivDataDir !== undefined) process.env.ARXIV_DATA_DIR = savedArxivDataDir;
    else delete process.env.ARXIV_DATA_DIR;
    if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
    fetchSpy.mockReset();
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('waits when a recent shared-process acquire timestamp exists', async () => {
    const calledAt: number[] = [];
    fetchSpy.mockImplementation(async () => {
      calledAt.push(Date.now());
      return new Response('{}', { status: 200 });
    });

    const { arxivFetch } = await import('../src/api/rateLimiter.js');

    const request = arxivFetch('https://export.arxiv.org/api/query?max_results=1');
    await vi.advanceTimersByTimeAsync(2999);
    expect(fetchSpy).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    await request;

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(calledAt[0]).toBe(new Date('2026-03-24T03:00:07Z').getTime());
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// H-10 regression — arxivFetch entry guard + redirect Location validation
// Source of bug:
//   1. rateLimiter.ts:237-240 used default `redirect: 'follow'` letting Node
//      follow up to 20 redirects to any host.
//   2. The exported `arxivFetch(url, options)` accepted arbitrary URLs at
//      the public surface (used by hep-mcp via @autoresearch/arxiv-mcp/tooling).
//
// Defense:
//   - validateArxivEntryUrl at the public entry point
//   - validateArxivRedirectTarget on each redirect hop
//   - MAX_REDIRECTS = 5 cap
//   - ARXIV_ALLOWED_HOSTS = {export.arxiv.org}
// ─────────────────────────────────────────────────────────────────────────────
describe('H-10 regression — entry guard and redirect host allow-list', () => {
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

  // ── Entry guard (validateArxivEntryUrl) ──────────────────────────────────
  it('entry guard rejects non-https URL', async () => {
    const { arxivFetch } = await import('../src/api/rateLimiter.js');
    await expect(arxivFetch('http://export.arxiv.org/api/query')).rejects.toThrow(
      /non-https scheme/,
    );
    // fetch must NOT be called — guard fires before rate-limiter slot
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('entry guard rejects file:// URL', async () => {
    const { arxivFetch } = await import('../src/api/rateLimiter.js');
    await expect(arxivFetch('file:///etc/passwd')).rejects.toThrow(/non-https scheme/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('entry guard rejects URL with foreign host', async () => {
    const { arxivFetch } = await import('../src/api/rateLimiter.js');
    await expect(arxivFetch('https://evil.example.com/data')).rejects.toThrow(
      /host not in allow-list/,
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('entry guard rejects URL pointing at AWS metadata', async () => {
    const { arxivFetch } = await import('../src/api/rateLimiter.js');
    await expect(arxivFetch('https://169.254.169.254/latest/')).rejects.toThrow(
      /host not in allow-list/,
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('entry guard rejects sibling host (arxiv.org, not export.arxiv.org)', async () => {
    // Only export.arxiv.org is allowed; bare arxiv.org is not fetched today
    const { arxivFetch } = await import('../src/api/rateLimiter.js');
    await expect(arxivFetch('https://arxiv.org/pdf/2401.00001v1')).rejects.toThrow(
      /host not in allow-list/,
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('entry guard rejects unparseable URL', async () => {
    const { arxivFetch } = await import('../src/api/rateLimiter.js');
    await expect(arxivFetch('http://[invalid')).rejects.toThrow(/not a parseable URL/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('entry guard accepts valid export.arxiv.org URL', async () => {
    fetchSpy.mockResolvedValueOnce(new Response('{}', { status: 200 }));
    const { arxivFetch } = await import('../src/api/rateLimiter.js');
    const response = await arxivFetch('https://export.arxiv.org/api/query?max_results=1');
    expect(response.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  // ── Redirect handler (validateArxivRedirectTarget) ───────────────────────
  it('rejects redirect to http:// downgrade', async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(null, {
        status: 302,
        headers: { location: 'http://export.arxiv.org/pdf/2401.00001' },
      }),
    );
    const { arxivFetch } = await import('../src/api/rateLimiter.js');
    await expect(
      arxivFetch('https://export.arxiv.org/pdf/2401.00001'),
    ).rejects.toThrow(/non-https scheme/);
    expect(fetchSpy.mock.calls).toHaveLength(1);
  });

  it('rejects redirect to AWS metadata service', async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(null, {
        status: 302,
        headers: { location: 'https://169.254.169.254/latest/meta-data/' },
      }),
    );
    const { arxivFetch } = await import('../src/api/rateLimiter.js');
    await expect(
      arxivFetch('https://export.arxiv.org/pdf/2401.00001'),
    ).rejects.toThrow(/host not in allow-list/);
    expect(fetchSpy.mock.calls).toHaveLength(1);
  });

  it('rejects redirect to attacker-controlled host', async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(null, {
        status: 302,
        headers: { location: 'https://evil.example.com/leak' },
      }),
    );
    const { arxivFetch } = await import('../src/api/rateLimiter.js');
    await expect(
      arxivFetch('https://export.arxiv.org/pdf/2401.00001'),
    ).rejects.toThrow(/host not in allow-list/);
    expect(fetchSpy.mock.calls).toHaveLength(1);
  });

  it('accepts redirect within export.arxiv.org (canonical URL)', async () => {
    fetchSpy
      .mockResolvedValueOnce(
        new Response(null, {
          status: 301,
          headers: { location: 'https://export.arxiv.org/pdf/2401.00001v2' },
        }),
      )
      .mockResolvedValueOnce(new Response('PDF', { status: 200 }));
    const { arxivFetch } = await import('../src/api/rateLimiter.js');
    const response = await arxivFetch('https://export.arxiv.org/pdf/2401.00001');
    expect(response.status).toBe(200);
    expect(fetchSpy.mock.calls[1][0]).toBe('https://export.arxiv.org/pdf/2401.00001v2');
  });

  it('resolves relative Location against current URL and accepts', async () => {
    fetchSpy
      .mockResolvedValueOnce(
        new Response(null, {
          status: 302,
          headers: { location: '/pdf/2401.00001v2' },
        }),
      )
      .mockResolvedValueOnce(new Response('PDF', { status: 200 }));
    const { arxivFetch } = await import('../src/api/rateLimiter.js');
    const response = await arxivFetch('https://export.arxiv.org/pdf/2401.00001');
    expect(response.status).toBe(200);
    expect(fetchSpy.mock.calls[1][0]).toBe('https://export.arxiv.org/pdf/2401.00001v2');
  });

  it('enforces MAX_REDIRECTS cap (5 hops)', async () => {
    for (let i = 0; i < 6; i++) {
      fetchSpy.mockResolvedValueOnce(
        new Response(null, {
          status: 302,
          headers: { location: `https://export.arxiv.org/hop/${i + 1}` },
        }),
      );
    }
    const { arxivFetch } = await import('../src/api/rateLimiter.js');
    await expect(
      arxivFetch('https://export.arxiv.org/pdf/2401.00001'),
    ).rejects.toThrow(/redirect limit \(5\) exceeded/);
    expect(fetchSpy.mock.calls).toHaveLength(6);
  });

  it('rejects missing Location header on 302', async () => {
    fetchSpy.mockResolvedValueOnce(new Response(null, { status: 302 }));
    const { arxivFetch } = await import('../src/api/rateLimiter.js');
    await expect(
      arxivFetch('https://export.arxiv.org/pdf/2401.00001'),
    ).rejects.toThrow(/redirect missing Location header/);
    expect(fetchSpy.mock.calls).toHaveLength(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// H-10 regression — downloadFile size cap (paperFetcher.ts)
// Bug: downloadFile streamed response body to disk with no size limit.
// Defense:
//   - Pre-check Content-Length header against cap
//   - Stream-side byte counter aborts mid-pipeline if cap exceeded
//   - Partial file on disk is unlinked on cap-exceeded error
// ─────────────────────────────────────────────────────────────────────────────
describe('H-10 regression — downloadFile size cap', () => {
  const fetchSpy = vi.fn();
  let tmpDir: string;
  let savedCapEnv: string | undefined;

  beforeEach(() => {
    savedCapEnv = process.env.ARXIV_MAX_DOWNLOAD_BYTES;
    vi.stubGlobal('fetch', fetchSpy);
    vi.resetModules();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'arxiv-h10-'));
  });

  afterEach(() => {
    if (savedCapEnv !== undefined) {
      process.env.ARXIV_MAX_DOWNLOAD_BYTES = savedCapEnv;
    } else {
      delete process.env.ARXIV_MAX_DOWNLOAD_BYTES;
    }
    fetchSpy.mockReset();
    vi.unstubAllGlobals();
    vi.resetModules();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  it('rejects pre-stream via Content-Length when over cap', async () => {
    // Set a small cap, then return a body with a Content-Length that exceeds it
    process.env.ARXIV_MAX_DOWNLOAD_BYTES = '1024'; // 1 KB
    const oversized = Buffer.alloc(2048);
    fetchSpy.mockResolvedValueOnce(
      new Response(oversized, {
        status: 200,
        headers: { 'content-length': '2048' },
      }),
    );

    const { downloadFile } = await import('../src/source/paperFetcher.js');
    const dest = path.join(tmpDir, 'out.bin');

    await expect(
      downloadFile('https://export.arxiv.org/pdf/2401.00001', dest),
    ).rejects.toThrow(/Content-Length 2048 exceeds cap 1024/);
    // No partial file should remain
    expect(fs.existsSync(dest)).toBe(false);
  });

  it('aborts stream when bytes exceed cap (no Content-Length header)', async () => {
    process.env.ARXIV_MAX_DOWNLOAD_BYTES = '1024'; // 1 KB
    // 2 KB body, no Content-Length so pre-check cannot fire
    const oversized = Buffer.alloc(2048);
    fetchSpy.mockResolvedValueOnce(
      new Response(oversized, {
        status: 200,
        // intentionally NO 'content-length' header
      }),
    );

    const { downloadFile } = await import('../src/source/paperFetcher.js');
    const dest = path.join(tmpDir, 'out.bin');

    await expect(
      downloadFile('https://export.arxiv.org/pdf/2401.00001', dest),
    ).rejects.toThrow(/exceeded cap of 1024 bytes/);
    // Partial file removed on cap-exceeded
    expect(fs.existsSync(dest)).toBe(false);
  });

  it('accepts download under cap', async () => {
    process.env.ARXIV_MAX_DOWNLOAD_BYTES = String(1024 * 1024); // 1 MB
    const small = Buffer.from('arxiv-paper-body', 'utf-8');
    fetchSpy.mockResolvedValueOnce(
      new Response(small, {
        status: 200,
        headers: { 'content-length': String(small.length) },
      }),
    );

    const { downloadFile } = await import('../src/source/paperFetcher.js');
    const dest = path.join(tmpDir, 'out.bin');

    await downloadFile('https://export.arxiv.org/pdf/2401.00001', dest);
    expect(fs.readFileSync(dest, 'utf-8')).toBe('arxiv-paper-body');
  });
});
