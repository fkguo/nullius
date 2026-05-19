import {
  parseRetryAfterMs,
  rateLimit,
  SerialTaskQueue,
  sleepWithAbort,
  upstreamError,
} from '@autoresearch/shared';

const OPENALEX_BASE_URL = 'https://api.openalex.org';
const MIN_INTERVAL_MS = Number(process.env.OPENALEX_MIN_INTERVAL_MS ?? '100');
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_RETRIES = 3;
const BACKOFF_BASE_MS = 1_000;
const BACKOFF_MAX_MS = 32_000;
const TOTAL_RETRY_WALL_TIME_MS = 120_000;
const MAX_REDIRECTS = 5;

/**
 * B-2 SSRF defense: only follow redirects to known OpenAlex hosts. Without
 * this, a compromised/malicious upstream OR DNS rebinding could redirect to
 * `http://169.254.169.254/...` (AWS metadata), `file://`, internal services,
 * etc. Pure SSRF reach.
 *
 * `api.openalex.org` is the API surface (used by `buildUrl()`).
 * `content.openalex.org` is the full-text content surface (see
 * `contentDownload.ts:21` `CONTENT_BASE_URL`).
 */
const OPENALEX_ALLOWED_REDIRECT_HOSTS: ReadonlySet<string> = new Set([
  'api.openalex.org',
  'content.openalex.org',
]);

/**
 * Validate a redirect target. Returns the absolute URL string on success, or
 * throws an upstream error on policy violation.
 *
 * Rules (B-2):
 *   1. Must parse as a URL (relative is resolved against `currentUrl`).
 *   2. Scheme must be `https:`. No `http:`, `file:`, `data:`, etc.
 *   3. Hostname must be in `OPENALEX_ALLOWED_REDIRECT_HOSTS`.
 *
 * `api_key` re-transfer to cross-host: not a vector today because `buildUrl()`
 * runs only at entry and the recursion call passes the Location string
 * directly (no re-build). If `init` ever carries auth headers, this allow-list
 * also bounds where those go.
 */
function validateOpenAlexRedirectTarget(location: string, currentUrl: string): string {
  let target: URL;
  try {
    target = new URL(location, currentUrl);
  } catch {
    throw upstreamError(`OpenAlex redirect Location is not a parseable URL: ${location}`);
  }
  if (target.protocol !== 'https:') {
    throw upstreamError(`OpenAlex redirect blocked (non-https scheme): ${target.protocol}`);
  }
  if (!OPENALEX_ALLOWED_REDIRECT_HOSTS.has(target.hostname)) {
    throw upstreamError(`OpenAlex redirect blocked (host not in allow-list): ${target.hostname}`);
  }
  return target.toString();
}

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

/**
 * B-1 defense: never let the api_key query parameter survive into error
 * messages, log lines, or any user-visible string. `buildUrl()` adds
 * `api_key=<secret>` to the URL search params; this helper strips it back out
 * before any url goes into an `upstreamError` / `rateLimit` / log message.
 *
 * Defense-in-depth with `dispatcher.ts`'s `redact()` call: even if a URL slips
 * through here, `redact()` masks `api_key=<value>` patterns at the tool-result
 * serialization boundary.
 */
function stripSecretsFromUrl(url: string): string {
  try {
    const u = new URL(url);
    u.searchParams.delete('api_key');
    return u.toString();
  } catch {
    return '<invalid url>';
  }
}

/**
 * Strip `api_key=<value>` substrings from free-form text.
 *
 * Used when upstream throws an Error whose `.message` may contain a URL
 * fragment with the secret embedded (e.g. undici TypeError on malformed URL
 * input includes the FULL URL in the message — see B1.1 reviewer finding).
 *
 * Stops at common URL/text separators (`&`, `#`, whitespace, quote/paren) so
 * base64-ish keys with `_ - + / =` are masked correctly (the shared
 * `redact()` regex only matches `[a-zA-Z0-9]{16,}` which would let such keys
 * through).
 */
function stripSecretsFromMessage(text: string): string {
  return text.replace(/api_key=[^&\s#"'`)]+/gi, 'api_key=***');
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
  private readonly slot = new SerialTaskQueue();
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
    return this.slot.run(async () => {
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
    });
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
        throw upstreamError(`OpenAlex request timed out: ${stripSecretsFromUrl(url)}`);
      }
      // B1.1: undici TypeError for malformed URL puts the FULL URL (with
      // api_key) into err.message. Strip secrets from any embedded URL text
      // before interpolating. `stripSecretsFromMessage` is a regex strip that
      // handles api_key=<value> substrings anywhere in the text.
      const rawMessage = err instanceof Error ? err.message : String(err);
      throw upstreamError(`OpenAlex request failed: ${stripSecretsFromMessage(rawMessage)}`);
    }

    // Handle manual redirects to enforce limit + SSRF defense (B-2)
    if (response.status >= 301 && response.status <= 308) {
      if (redirectCount >= MAX_REDIRECTS) {
        // B1.1 defensive: redirect-limit error today carries no URL, but
        // future changes might. Keep the message constant; if URL info is
        // ever added, wrap via stripSecretsFromUrl / stripSecretsFromMessage.
        throw upstreamError(`OpenAlex redirect limit (${MAX_REDIRECTS}) exceeded`);
      }
      const location = response.headers.get('location');
      if (!location) throw upstreamError('OpenAlex redirect missing Location header');
      // B-2: validate scheme + hostname before recursing; reject http://,
      // file://, internal services, AWS metadata, etc.
      const safeLocation = validateOpenAlexRedirectTarget(location, url);
      return this.fetchWithRetry(safeLocation, init, signal, attempt, startTime, redirectCount + 1);
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
        waitMs = parseRetryAfterMs(response.headers.get('retry-after')) ?? BACKOFF_BASE_MS;
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
        await sleepWithAbort(
          waitMs,
          signal,
          () => upstreamError('OpenAlex request aborted during retry wait'),
        );
      }

      this.retryCount++;
      return this.fetchWithRetry(url, init, signal, attempt + 1, startTime, redirectCount);
    }

    if (response.status === 429) {
      throw rateLimit(
        'OpenAlex rate limit exceeded',
        parseRetryAfterMs(response.headers.get('retry-after')),
      );
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
