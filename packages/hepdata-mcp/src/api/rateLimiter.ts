import { rateLimit, upstreamError } from '@autoresearch/shared';

const HEPDATA_BASE_URL = 'https://www.hepdata.net';
const MIN_INTERVAL_MS = 1000; // 1 req/second (conservative; HEPData limits at 60/min)
const REQUEST_TIMEOUT_MS = 30000;
const MAX_RETRIES = 3;

function isTestEnv(): boolean {
  return Boolean(process.env.VITEST ?? process.env.NODE_ENV === 'test');
}

class HEPDataRateLimiter {
  private static instance: HEPDataRateLimiter | null = null;
  private lastRequestMs = 0;
  // Serialise throttle waits so concurrent callers queue up rather than racing.
  private throttle = Promise.resolve();

  private constructor() {}

  static getInstance(): HEPDataRateLimiter {
    if (!HEPDataRateLimiter.instance) {
      HEPDataRateLimiter.instance = new HEPDataRateLimiter();
    }
    return HEPDataRateLimiter.instance;
  }

  async fetch(urlPath: string, init?: RequestInit): Promise<Response> {
    if (!isTestEnv()) {
      const myTurn = this.throttle.then(async () => {
        const elapsed = Date.now() - this.lastRequestMs;
        if (elapsed < MIN_INTERVAL_MS) {
          await new Promise<void>(r => setTimeout(r, MIN_INTERVAL_MS - elapsed));
        }
        this.lastRequestMs = Date.now();
      });
      this.throttle = myTurn;
      await myTurn;
    }

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
      const retryAfterHeader = response.headers.get('retry-after') ?? '10';
      // Retry-After can be a numeric seconds value or an HTTP-date string.
      const parsedSec = Number(retryAfterHeader);
      const retryAfterMs = Number.isFinite(parsedSec) && parsedSec >= 0
        ? parsedSec * 1000
        : 10_000; // fallback for HTTP-date format
      if (!isTestEnv()) {
        // Respect the timeout: if waiting would exceed the remaining budget, give up.
        const remaining = REQUEST_TIMEOUT_MS - (Date.now() - startTime);
        if (retryAfterMs >= remaining) {
          throw rateLimit('HEPData rate limit: retry-after exceeds remaining timeout budget');
        }
        await new Promise<void>((resolve, reject) => {
          const onAbort = () => { clearTimeout(timer); reject(upstreamError('HEPData request timed out during retry wait')); };
          const timer = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve(); }, retryAfterMs);
          signal.addEventListener('abort', onAbort, { once: true });
        });
      }
      return this.fetchWithRetry(url, init, signal, attempt + 1, startTime);
    }

    if (response.status === 429) {
      throw rateLimit('HEPData rate limit exceeded');
    }

    return response;
  }
}

export async function hepdataFetch(urlPath: string, init?: RequestInit): Promise<Response> {
  return HEPDataRateLimiter.getInstance().fetch(urlPath, init);
}
