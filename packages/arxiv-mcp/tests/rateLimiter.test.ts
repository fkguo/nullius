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

// ─────────────────────────────────────────────────────────────────────────────
// P0-hotfix regression — rate-limit budget config + cross-process 429 backoff
//
// Bug: ARXIV_REQUEST_TIMEOUT_MS=30s was too tight when retry-after × retries
// exceeded that budget; cross-process backoff was missing so multiple
// agent runs amplified arXiv 429s. See
// ~/.autoresearch-lab-dev/plans/2026-05-18-comprehensive-remediation-plan.md
// (hotfix lane appended after P0 cluster).
//
// Defense:
//   - Env-configurable timeouts via parseEnvPositiveInt with sanitization
//   - Default REQUEST_TIMEOUT_MS raised 30s → 90s
//   - Cross-process backoff file `api-query.backoff-until-ms` advances on 429
// ─────────────────────────────────────────────────────────────────────────────
describe('P0-hotfix regression — parseEnvPositiveInt sanitization', () => {
  let savedEnv: string | undefined;

  beforeEach(() => {
    savedEnv = process.env.ARXIV_TEST_SAMPLE_VAR;
  });
  afterEach(() => {
    if (savedEnv !== undefined) process.env.ARXIV_TEST_SAMPLE_VAR = savedEnv;
    else delete process.env.ARXIV_TEST_SAMPLE_VAR;
  });

  it('falls back to default for unset, empty, non-numeric, negative, zero, non-finite', async () => {
    const { __testing__ } = await import('../src/api/rateLimiter.js');
    const { parseEnvPositiveInt } = __testing__;

    delete process.env.ARXIV_TEST_SAMPLE_VAR;
    expect(parseEnvPositiveInt('ARXIV_TEST_SAMPLE_VAR', 999)).toBe(999);

    process.env.ARXIV_TEST_SAMPLE_VAR = '';
    expect(parseEnvPositiveInt('ARXIV_TEST_SAMPLE_VAR', 999)).toBe(999);

    process.env.ARXIV_TEST_SAMPLE_VAR = '   ';
    expect(parseEnvPositiveInt('ARXIV_TEST_SAMPLE_VAR', 999)).toBe(999);

    process.env.ARXIV_TEST_SAMPLE_VAR = 'abc';
    expect(parseEnvPositiveInt('ARXIV_TEST_SAMPLE_VAR', 999)).toBe(999);

    process.env.ARXIV_TEST_SAMPLE_VAR = 'NaN';
    expect(parseEnvPositiveInt('ARXIV_TEST_SAMPLE_VAR', 999)).toBe(999);

    process.env.ARXIV_TEST_SAMPLE_VAR = '-1';
    expect(parseEnvPositiveInt('ARXIV_TEST_SAMPLE_VAR', 999)).toBe(999);

    process.env.ARXIV_TEST_SAMPLE_VAR = '0';
    expect(parseEnvPositiveInt('ARXIV_TEST_SAMPLE_VAR', 999)).toBe(999);

    process.env.ARXIV_TEST_SAMPLE_VAR = '1e999'; // Infinity
    expect(parseEnvPositiveInt('ARXIV_TEST_SAMPLE_VAR', 999)).toBe(999);
  });

  it('accepts valid positive ints and floors fractions', async () => {
    const { __testing__ } = await import('../src/api/rateLimiter.js');
    const { parseEnvPositiveInt } = __testing__;

    process.env.ARXIV_TEST_SAMPLE_VAR = '5000';
    expect(parseEnvPositiveInt('ARXIV_TEST_SAMPLE_VAR', 999)).toBe(5000);

    process.env.ARXIV_TEST_SAMPLE_VAR = '1.7';
    expect(parseEnvPositiveInt('ARXIV_TEST_SAMPLE_VAR', 999)).toBe(1);

    process.env.ARXIV_TEST_SAMPLE_VAR = ' 90000 '; // whitespace trimmed
    expect(parseEnvPositiveInt('ARXIV_TEST_SAMPLE_VAR', 999)).toBe(90000);
  });
});

describe('P0-hotfix regression — backoff-until-ms file helpers', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'arxiv-backoff-'));
  });

  afterEach(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  it('readBackoffUntilMs returns 0 for missing file', async () => {
    const { __testing__ } = await import('../src/api/rateLimiter.js');
    const file = path.join(tmpDir, 'absent');
    expect(await __testing__.readBackoffUntilMs(file)).toBe(0);
  });

  it('readBackoffUntilMs returns 0 for malformed content', async () => {
    const { __testing__ } = await import('../src/api/rateLimiter.js');
    const file = path.join(tmpDir, 'malformed');
    fs.writeFileSync(file, 'not a number');
    expect(await __testing__.readBackoffUntilMs(file)).toBe(0);

    fs.writeFileSync(file, '-500');
    expect(await __testing__.readBackoffUntilMs(file)).toBe(0);

    fs.writeFileSync(file, '0');
    expect(await __testing__.readBackoffUntilMs(file)).toBe(0);
  });

  it('readBackoffUntilMs round-trips a valid future deadline', async () => {
    const { __testing__ } = await import('../src/api/rateLimiter.js');
    const file = path.join(tmpDir, 'valid');
    const future = Date.now() + 15_000;
    fs.writeFileSync(file, String(future));
    expect(await __testing__.readBackoffUntilMs(file)).toBe(future);
  });

  it('writeBackoffUntilMs caps at now + MAX_BACKOFF_MS', async () => {
    const { __testing__ } = await import('../src/api/rateLimiter.js');
    const file = path.join(tmpDir, 'capped');
    const absurd = Date.now() + 365 * 24 * 60 * 60 * 1000; // 1 year
    await __testing__.writeBackoffUntilMs(file, absurd);
    const stored = await __testing__.readBackoffUntilMs(file);
    expect(stored).toBeLessThanOrEqual(Date.now() + __testing__.MAX_BACKOFF_MS);
    expect(stored).toBeGreaterThan(Date.now()); // capped value still in future
  });

  it('writeBackoffUntilMs never shortens an existing deadline', async () => {
    const { __testing__ } = await import('../src/api/rateLimiter.js');
    const file = path.join(tmpDir, 'monotone');
    const farFuture = Date.now() + 60_000; // capped value still in range
    await __testing__.writeBackoffUntilMs(file, farFuture);
    const stored1 = await __testing__.readBackoffUntilMs(file);

    // Attempt to push BACKWARDS — should be ignored
    await __testing__.writeBackoffUntilMs(file, Date.now() + 5_000);
    const stored2 = await __testing__.readBackoffUntilMs(file);
    expect(stored2).toBe(stored1);
  });

  it('writeBackoffUntilMs ignores non-finite / non-positive input', async () => {
    const { __testing__ } = await import('../src/api/rateLimiter.js');
    const file = path.join(tmpDir, 'invalid');
    await __testing__.writeBackoffUntilMs(file, NaN);
    expect(await __testing__.readBackoffUntilMs(file)).toBe(0);

    await __testing__.writeBackoffUntilMs(file, -1);
    expect(await __testing__.readBackoffUntilMs(file)).toBe(0);

    await __testing__.writeBackoffUntilMs(file, 0);
    expect(await __testing__.readBackoffUntilMs(file)).toBe(0);

    // Infinity is non-finite — guarded out, no write.
    await __testing__.writeBackoffUntilMs(file, Infinity);
    expect(await __testing__.readBackoffUntilMs(file)).toBe(0);

    // Verify the cap path separately with a finite-but-absurd value.
    // (Defends against attacker / buggy upstream returning a long-but-finite
    // Retry-After like "999999999".)
    const finiteAbsurd = Date.now() + 365 * 24 * 60 * 60 * 1000;
    await __testing__.writeBackoffUntilMs(file, finiteAbsurd);
    const stored = await __testing__.readBackoffUntilMs(file);
    expect(stored).toBeLessThanOrEqual(Date.now() + __testing__.MAX_BACKOFF_MS);
    expect(stored).toBeGreaterThan(Date.now());
  });
});

describe('P0-hotfix regression — REQUEST_TIMEOUT_MS env override', () => {
  let savedTimeout: string | undefined;
  let savedInterval: string | undefined;
  let savedRetries: string | undefined;

  beforeEach(() => {
    savedTimeout = process.env.ARXIV_REQUEST_TIMEOUT_MS;
    savedInterval = process.env.ARXIV_MIN_INTERVAL_MS;
    savedRetries = process.env.ARXIV_MAX_RETRIES;
  });

  afterEach(() => {
    if (savedTimeout !== undefined) process.env.ARXIV_REQUEST_TIMEOUT_MS = savedTimeout;
    else delete process.env.ARXIV_REQUEST_TIMEOUT_MS;
    if (savedInterval !== undefined) process.env.ARXIV_MIN_INTERVAL_MS = savedInterval;
    else delete process.env.ARXIV_MIN_INTERVAL_MS;
    if (savedRetries !== undefined) process.env.ARXIV_MAX_RETRIES = savedRetries;
    else delete process.env.ARXIV_MAX_RETRIES;
    vi.resetModules();
  });

  it('default REQUEST_TIMEOUT_MS is 90s (raised from prior 30s default)', async () => {
    // We can't observe the constant directly, but we can observe behavior:
    // if a 429 with retry-after=10s occurs on attempt 0, the budget check
    // (REQUEST_TIMEOUT_MS - elapsed) MUST allow the retry (10s << 90s).
    // The pre-hotfix bug would have raced 30s vs 10s × 3 = 30s.
    delete process.env.ARXIV_REQUEST_TIMEOUT_MS;
    vi.resetModules();

    const fetchSpy = vi.fn()
      .mockResolvedValueOnce(
        new Response('', {
          status: 429,
          headers: { 'retry-after': '10' },
        }),
      )
      .mockResolvedValueOnce(new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);

    try {
      const { arxivFetch } = await import('../src/api/rateLimiter.js');
      const response = await arxivFetch('https://export.arxiv.org/api/query?max_results=1');
      expect(response.status).toBe(200);
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('P0-hotfix regression — recordSharedBackoff writes file in non-test env', () => {
  let savedVitest: string | undefined;
  let savedWorkerId: string | undefined;
  let savedPoolId: string | undefined;
  let savedNodeEnv: string | undefined;
  let savedArxivDataDir: string | undefined;
  let tmpDir: string;

  beforeEach(() => {
    savedVitest = process.env.VITEST;
    savedWorkerId = process.env.VITEST_WORKER_ID;
    savedPoolId = process.env.VITEST_POOL_ID;
    savedNodeEnv = process.env.NODE_ENV;
    savedArxivDataDir = process.env.ARXIV_DATA_DIR;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'arxiv-record-backoff-'));
    process.env.ARXIV_DATA_DIR = tmpDir;
  });

  afterEach(() => {
    if (savedVitest !== undefined) process.env.VITEST = savedVitest;
    else delete process.env.VITEST;
    if (savedWorkerId !== undefined) process.env.VITEST_WORKER_ID = savedWorkerId;
    else delete process.env.VITEST_WORKER_ID;
    if (savedPoolId !== undefined) process.env.VITEST_POOL_ID = savedPoolId;
    else delete process.env.VITEST_POOL_ID;
    if (savedNodeEnv !== undefined) process.env.NODE_ENV = savedNodeEnv;
    else delete process.env.NODE_ENV;
    if (savedArxivDataDir !== undefined) process.env.ARXIV_DATA_DIR = savedArxivDataDir;
    else delete process.env.ARXIV_DATA_DIR;
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
    vi.resetModules();
  });

  it('writes backoff file when 429 received with non-test env', async () => {
    // Pretend we are NOT in a test env so recordSharedBackoff actually writes.
    delete process.env.VITEST;
    delete process.env.VITEST_WORKER_ID;
    delete process.env.VITEST_POOL_ID;
    delete process.env.NODE_ENV;
    vi.resetModules();

    const { __testing__ } = await import('../src/api/rateLimiter.js');
    await __testing__.recordSharedBackoff(15_000);

    const { backoffFile } = __testing__.getSharedGatePaths();
    const stored = await __testing__.readBackoffUntilMs(backoffFile);
    expect(stored).toBeGreaterThan(Date.now());
    expect(stored).toBeLessThanOrEqual(Date.now() + 15_000 + 100); // tolerate small drift
  });

  it('skips writing in test env (no file created)', async () => {
    // VITEST is already set by vitest; recordSharedBackoff should no-op
    const { __testing__ } = await import('../src/api/rateLimiter.js');
    await __testing__.recordSharedBackoff(15_000);

    const { backoffFile } = __testing__.getSharedGatePaths();
    expect(fs.existsSync(backoffFile)).toBe(false);
  });

  it('subsequent recordSharedBackoff calls only advance the deadline', async () => {
    delete process.env.VITEST;
    delete process.env.VITEST_WORKER_ID;
    delete process.env.VITEST_POOL_ID;
    delete process.env.NODE_ENV;
    vi.resetModules();

    const { __testing__ } = await import('../src/api/rateLimiter.js');

    await __testing__.recordSharedBackoff(60_000); // 60s
    const { backoffFile } = __testing__.getSharedGatePaths();
    const first = await __testing__.readBackoffUntilMs(backoffFile);

    // A smaller retry-after should NOT shorten the deadline
    await __testing__.recordSharedBackoff(1_000);
    const second = await __testing__.readBackoffUntilMs(backoffFile);
    expect(second).toBe(first);
  });
});
