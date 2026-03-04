import { rateLimit, upstreamError } from '@autoresearch/shared';

const OPENALEX_BASE_URL = 'https://api.openalex.org';
const MIN_INTERVAL_MS = Number(process.env.OPENALEX_MIN_INTERVAL_MS ?? '100');
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_RETRIES = 3;
const BACKOFF_BASE_MS = 1_000;
const BACKOFF_MAX_MS = 32_000;
const TOTAL_RETRY_WALL_TIME_MS = 120_000;
const MAX_REDIRECTS = 5;

export interface CostSummary {
  cumulative_usd: number;
  remaining_usd: number | null;
  resets_at: string | null;
}

export interface ResponseMeta {
  pages_fetched: number;
  retries: number;
  cost_usd: number;
  last_headers_at: string | null;
}

function isTestEnv(): boolean {
  return Boolean(process.env.VITEST ?? process.env.NODE_ENV === 'test');
}

function getApiKey(): string | null {
  return process.env.OPENALEX_API_KEY?.trim() || null;
}

function getMailto(): string | null {
  return process.env.OPENALEX_MAILTO?.trim() || null;
}

function getMaxBudgetUsd(): number {
  const val = parseFloat(process.env.OPENALEX_MAX_COST_USD ?? '0.50');
  return Number.isFinite(val) && val > 0 ? val : 0.50;
}

class OpenAlexRateLimiter {
  private static instance: OpenAlexRateLimiter | null = null;
  private lastRequestMs = 0;
  /**
   * Mutex-style slot: each caller awaits `this.slot`, then sets `this.slot`
   * to a new Promise it resolves in `finally`. This serialises the complete
   * request lifecycle (budget check + interval wait + HTTP + header accounting),
   * so budget updates from one request are visible before the next begins.
   */
  private slot = Promise.resolve();
  private cumulativeCostUsd = 0;
  private remainingBudgetUsd: number | null = null;
  private budgetResetsAt: string | null = null;
  private lastHeadersAt: number | null = null;
  private requestCount = 0;
  private retryCount = 0;

  private constructor() {}

  static getInstance(): OpenAlexRateLimiter {
    if (!OpenAlexRateLimiter.instance) {
      OpenAlexRateLimiter.instance = new OpenAlexRateLimiter();
    }
    return OpenAlexRateLimiter.instance;
  }

  /** Returns true if cumulative cost has exceeded the session budget cap. */
  isBudgetExceeded(): boolean {
    return this.cumulativeCostUsd >= getMaxBudgetUsd();
  }

  getCostSummary(): CostSummary {
    return {
      cumulative_usd: this.cumulativeCostUsd,
      remaining_usd: this.remainingBudgetUsd,
      resets_at: this.budgetResetsAt,
    };
  }

  getMeta(): ResponseMeta {
    return {
      pages_fetched: this.requestCount,
      retries: this.retryCount,
      cost_usd: this.cumulativeCostUsd,
      last_headers_at: this.lastHeadersAt != null ? new Date(this.lastHeadersAt).toISOString() : null,
    };
  }

  /**
   * Runs `fn` inside a serialised slot: waits for any in-flight request to
   * finish, then executes budget check + interval wait + fn() atomically.
   * `releaseSlot` is always called in `finally`, so errors never block the queue.
   */
  private async withSlot<T>(fn: () => Promise<T>): Promise<T> {
    // Fast path: reject before queuing if budget is already exceeded
    if (this.isBudgetExceeded()) {
      throw rateLimit('OpenAlex session budget cap reached; use openalex_rate_limit to check cost');
    }
    if (isTestEnv()) {
      return fn();
    }
    // Reserve the next slot
    let releaseSlot!: () => void;
    const prevSlot = this.slot;
    this.slot = new Promise<void>(r => { releaseSlot = r; });
    await prevSlot;
    try {
      // Re-check after waiting: previous request may have consumed the budget
      if (this.isBudgetExceeded()) {
        throw rateLimit('OpenAlex session budget cap reached; use openalex_rate_limit to check cost');
      }
      // Enforce minimum interval between requests
      const elapsed = Date.now() - this.lastRequestMs;
      if (elapsed < MIN_INTERVAL_MS) {
        await new Promise<void>(r => setTimeout(r, MIN_INTERVAL_MS - elapsed));
      }
      this.lastRequestMs = Date.now();
      return await fn();
    } finally {
      releaseSlot();
    }
  }

  async fetch(urlPath: string, init?: RequestInit): Promise<Response> {
    const url = this.buildUrl(urlPath);
    return this.withSlot(async () => {
      const startTime = Date.now();
      const controller = new AbortController();
      const timeout = !isTestEnv()
        ? setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
        : undefined;
      try {
        const response = await this.fetchWithRetry(url, init, controller.signal, 0, startTime);
        this.parseRateLimitHeaders(response.headers);
        this.requestCount++;
        return response;
      } finally {
        if (timeout != null) clearTimeout(timeout);
      }
    });
  }

  /** Fetch a full URL (used by content download, which has its own base URL). */
  async fetchFullUrl(url: string, init?: RequestInit): Promise<Response> {
    return this.withSlot(async () => {
      const startTime = Date.now();
      const controller = new AbortController();
      const timeout = !isTestEnv()
        ? setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
        : undefined;
      try {
        const response = await this.fetchWithRetry(url, init, controller.signal, 0, startTime);
        this.parseRateLimitHeaders(response.headers);
        this.requestCount++;
        return response;
      } finally {
        if (timeout != null) clearTimeout(timeout);
      }
    });
  }

  private buildUrl(urlPath: string): string {
    const base = urlPath.startsWith('http') ? urlPath : `${OPENALEX_BASE_URL}${urlPath}`;
    const urlObj = new URL(base);
    const key = getApiKey();
    const mailto = getMailto();
    if (key) urlObj.searchParams.set('api_key', key);
    if (mailto && !urlObj.searchParams.has('mailto')) {
      urlObj.searchParams.set('mailto', mailto);
    }
    return urlObj.toString();
  }

  private getHeaders(): Record<string, string> {
    const mailto = getMailto();
    const ua = `openalex-mcp/0.1.0${mailto ? ` (mailto:${mailto})` : ''}`;
    return { 'User-Agent': ua, 'Accept': 'application/json' };
  }

  private async fetchWithRetry(
    url: string,
    init: RequestInit | undefined,
    signal: AbortSignal,
    attempt: number,
    startTime: number,
    redirectCount = 0,
  ): Promise<Response> {
    let response: Response;
    try {
      response = await fetch(url, {
        ...init,
        signal,
        redirect: 'manual',
        headers: { ...this.getHeaders(), ...(init?.headers ?? {}) },
      });
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        throw upstreamError(`OpenAlex request timed out: ${url}`);
      }
      throw upstreamError(
        `OpenAlex request failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // Handle manual redirects to enforce limit
    if (response.status >= 301 && response.status <= 308) {
      if (redirectCount >= MAX_REDIRECTS) {
        throw upstreamError(`OpenAlex redirect limit (${MAX_REDIRECTS}) exceeded`);
      }
      const location = response.headers.get('location');
      if (!location) throw upstreamError('OpenAlex redirect missing Location header');
      return this.fetchWithRetry(location, init, signal, attempt, startTime, redirectCount + 1);
    }

    // Budget-exhausted detection (402/403): return partial result signal, not an error
    if (response.status === 402) {
      throw rateLimit('OpenAlex budget exhausted (HTTP 402)', undefined);
    }

    // Retryable errors
    const retryable = [429, 500, 502, 503, 504, 408];
    if (retryable.includes(response.status) && attempt < MAX_RETRIES) {
      let waitMs: number;
      if (response.status === 429) {
        const retryAfterHeader = response.headers.get('retry-after') ?? String(BACKOFF_BASE_MS / 1000);
        const parsedSec = Number(retryAfterHeader);
        waitMs = Number.isFinite(parsedSec) && parsedSec >= 0 ? parsedSec * 1000 : BACKOFF_BASE_MS;
      } else {
        // Exponential backoff with jitter
        const base = BACKOFF_BASE_MS * Math.pow(2, attempt);
        waitMs = Math.min(base + Math.random() * BACKOFF_BASE_MS, BACKOFF_MAX_MS);
      }

      if (!isTestEnv()) {
        const elapsed = Date.now() - startTime;
        if (elapsed + waitMs >= TOTAL_RETRY_WALL_TIME_MS) {
          throw rateLimit('OpenAlex retry wall-time exceeded');
        }
        await new Promise<void>((resolve, reject) => {
          const onAbort = () => {
            clearTimeout(timer);
            reject(upstreamError('OpenAlex request aborted during retry wait'));
          };
          const timer = setTimeout(() => {
            signal.removeEventListener('abort', onAbort);
            resolve();
          }, waitMs);
          signal.addEventListener('abort', onAbort, { once: true });
        });
      }

      this.retryCount++;
      return this.fetchWithRetry(url, init, signal, attempt + 1, startTime, redirectCount);
    }

    if (response.status === 429) {
      throw rateLimit('OpenAlex rate limit exceeded');
    }

    return response;
  }

  private parseRateLimitHeaders(headers: Headers): void {
    this.lastHeadersAt = Date.now();
    const cost = headers.get('x-ratelimit-cost-usd') ?? headers.get('X-RateLimit-Cost-USD');
    if (cost != null) {
      const parsed = parseFloat(cost);
      if (Number.isFinite(parsed)) this.cumulativeCostUsd += parsed;
    }
    const remaining = headers.get('x-ratelimit-remaining-usd') ?? headers.get('X-RateLimit-Remaining-USD');
    if (remaining != null) {
      const parsed = parseFloat(remaining);
      if (Number.isFinite(parsed)) this.remainingBudgetUsd = parsed;
    }
    const resets = headers.get('x-ratelimit-reset') ?? headers.get('X-RateLimit-Reset');
    if (resets != null) this.budgetResetsAt = resets;
  }
}

export const rateLimiter = OpenAlexRateLimiter.getInstance;

export async function openalexFetch(urlPath: string, init?: RequestInit): Promise<Response> {
  return OpenAlexRateLimiter.getInstance().fetch(urlPath, init);
}

export async function openalexFetchFullUrl(url: string, init?: RequestInit): Promise<Response> {
  return OpenAlexRateLimiter.getInstance().fetchFullUrl(url, init);
}

export function getRateLimiterInstance(): OpenAlexRateLimiter {
  return OpenAlexRateLimiter.getInstance();
}

export function isBudgetExceeded(): boolean {
  return OpenAlexRateLimiter.getInstance().isBudgetExceeded();
}

export function getCostSummary(): CostSummary {
  return OpenAlexRateLimiter.getInstance().getCostSummary();
}

export function getResponseMeta(): ResponseMeta {
  return OpenAlexRateLimiter.getInstance().getMeta();
}
