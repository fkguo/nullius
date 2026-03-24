import {
  parseRetryAfterMs,
  rateLimit,
  SerialIntervalGate,
  sleepWithAbort,
  upstreamError,
} from '@autoresearch/shared';

const HEPDATA_BASE_URL = 'https://www.hepdata.net';
const MIN_INTERVAL_MS = 1000; // 1 req/second (conservative; HEPData limits at 60/min)
const REQUEST_TIMEOUT_MS = 30000;
const MAX_RETRIES = 3;

function isTestEnv(): boolean {
  return Boolean(process.env.VITEST ?? process.env.NODE_ENV === 'test');
}

class HEPDataRateLimiter {
  private static instance: HEPDataRateLimiter | null = null;
  private readonly intervalGate = new SerialIntervalGate(MIN_INTERVAL_MS, isTestEnv);

  private constructor() {}

  static getInstance(): HEPDataRateLimiter {
    if (!HEPDataRateLimiter.instance) {
      HEPDataRateLimiter.instance = new HEPDataRateLimiter();
    }
    return HEPDataRateLimiter.instance;
  }

  async fetch(urlPath: string, init?: RequestInit): Promise<Response> {
    await this.intervalGate.acquire();

    const startTime = Date.now();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      return await this.fetchWithRetry(`${HEPDATA_BASE_URL}${urlPath}`, init, controller.signal, 0, startTime);
    } finally {
      clearTimeout(timeout);
    }
  }

  private async fetchWithRetry(
    url: string,
    init: RequestInit | undefined,
    signal: AbortSignal,
    attempt: number,
    startTime: number,
  ): Promise<Response> {
    let response: Response;
    try {
      response = await fetch(url, { ...init, signal, redirect: 'follow' });
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        throw upstreamError(`HEPData request timed out: ${url}`);
      }
      throw upstreamError(`HEPData request failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    if (response.status === 429 && attempt < MAX_RETRIES) {
      const retryAfterMs = parseRetryAfterMs(response.headers.get('retry-after')) ?? 10_000;
      if (!isTestEnv()) {
        // Respect the timeout: if waiting would exceed the remaining budget, give up.
        const remaining = REQUEST_TIMEOUT_MS - (Date.now() - startTime);
        if (retryAfterMs >= remaining) {
          throw rateLimit('HEPData rate limit: retry-after exceeds remaining timeout budget', retryAfterMs);
        }
        await sleepWithAbort(
          retryAfterMs,
          signal,
          () => upstreamError('HEPData request timed out during retry wait'),
        );
      }
      return this.fetchWithRetry(url, init, signal, attempt + 1, startTime);
    }

    if (response.status === 429) {
      throw rateLimit(
        'HEPData rate limit exceeded',
        parseRetryAfterMs(response.headers.get('retry-after')),
      );
    }

    return response;
  }
}

export async function hepdataFetch(urlPath: string, init?: RequestInit): Promise<Response> {
  return HEPDataRateLimiter.getInstance().fetch(urlPath, init);
}
