import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('arXiv rate limiter retry behavior', () => {
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
