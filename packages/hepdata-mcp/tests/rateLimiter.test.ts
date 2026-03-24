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
