import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('arXiv rate limiter', () => {
  const fetchSpy = vi.fn();
  let savedVitest: string | undefined;
  let savedVitestWorkerId: string | undefined;
  let savedVitestPoolId: string | undefined;
  let savedNodeEnv: string | undefined;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-24T03:00:04Z'));
    vi.stubGlobal('fetch', fetchSpy);
    vi.resetModules();
    savedVitest = process.env.VITEST;
    savedVitestWorkerId = process.env.VITEST_WORKER_ID;
    savedVitestPoolId = process.env.VITEST_POOL_ID;
    savedNodeEnv = process.env.NODE_ENV;
    delete process.env.VITEST;
    delete process.env.VITEST_WORKER_ID;
    delete process.env.VITEST_POOL_ID;
    process.env.NODE_ENV = 'production';
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
    fetchSpy.mockReset();
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('serializes concurrent requests through the shared interval gate', async () => {
    const calledAt: number[] = [];
    fetchSpy.mockImplementation(async () => {
      calledAt.push(Date.now());
      return new Response('{}', { status: 200 });
    });

    const { arxivFetch } = await import('../src/api/rateLimiter.js');

    const first = arxivFetch('https://export.arxiv.org/api/query?max_results=1');
    const second = arxivFetch('https://export.arxiv.org/api/query?max_results=2');
    await vi.advanceTimersByTimeAsync(3000);
    await Promise.all([first, second]);

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(calledAt[1] - calledAt[0]).toBe(3000);
  });
});
