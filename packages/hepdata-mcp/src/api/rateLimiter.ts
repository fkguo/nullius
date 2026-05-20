import {
  parseRetryAfterMs,
  rateLimit,
  SerialIntervalGate,
  sleepWithAbort,
  upstreamError,
} from '@autoresearch/shared';

/**
 * Parse a positive-integer env var. Falls back to `fallback` when the var
 * is unset, empty, non-numeric, non-finite, negative, zero, or non-integer.
 *
 * Sibling-lane copy of the same helper in arxiv-mcp and openalex-mcp.
 * Lifting to `@autoresearch/shared` is its own cleanup task — duplicated
 * here to keep this hotfix narrowly scoped to one package per file.
 */
function parseEnvPositiveInt(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
}

const HEPDATA_BASE_URL = 'https://www.hepdata.net';
// Env-configurable rate-limit knobs (P0-hotfix sibling lane).
// 1 req/second (conservative; HEPData limits at 60/min) is the default.
const MIN_INTERVAL_MS = parseEnvPositiveInt('HEPDATA_MIN_INTERVAL_MS', 1000);
// REQUEST_TIMEOUT_MS default raised 30s -> 90s for the same reason as
// arxiv-mcp / openalex-mcp: downloads + retry-after waits can routinely
// exceed 30s, and a tight budget collides with HTTP 429 retry-after.
const REQUEST_TIMEOUT_MS = parseEnvPositiveInt('HEPDATA_REQUEST_TIMEOUT_MS', 90_000);
const MAX_RETRIES = parseEnvPositiveInt('HEPDATA_MAX_RETRIES', 3);
const MAX_REDIRECTS = 5;

// Internal export for direct unit testing — see tests/rateLimiter.test.ts.
// Not part of the public surface.
export const __testing__ = {
  parseEnvPositiveInt,
};

/**
 * B-3 SSRF defense: only follow redirects to the known HEPData host. Without
 * this, the default `redirect: 'follow'` lets Node fetch follow up to 20
 * redirects to any host, allowing a compromised or DNS-rebound upstream to
 * redirect into `http://169.254.169.254/...` (AWS metadata), `file://`, or
 * internal services. HEPData only serves `www.hepdata.net`.
 */
const HEPDATA_ALLOWED_HOST = 'www.hepdata.net';

function isTestEnv(): boolean {
  return Boolean(process.env.VITEST ?? process.env.NODE_ENV === 'test');
}

/**
 * Validate a redirect target. Returns the absolute URL string on success, or
 * throws an upstream error on policy violation.
 *
 * Rules (B-3):
 *   1. Must parse as a URL (relative is resolved against `currentUrl`).
 *   2. Scheme must be `https:`.
 *   3. Hostname must equal `HEPDATA_ALLOWED_HOST`.
 */
function validateHepdataRedirectTarget(location: string, currentUrl: string): string {
  let target: URL;
  try {
    target = new URL(location, currentUrl);
  } catch {
    throw upstreamError(`HEPData redirect Location is not a parseable URL: ${location}`);
  }
  if (target.protocol !== 'https:') {
    throw upstreamError(`HEPData redirect blocked (non-https scheme): ${target.protocol}`);
  }
  if (target.hostname !== HEPDATA_ALLOWED_HOST) {
    throw upstreamError(`HEPData redirect blocked (host not in allow-list): ${target.hostname}`);
  }
  return target.toString();
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
    redirectCount = 0,
  ): Promise<Response> {
    let response: Response;
    try {
      response = await fetch(url, { ...init, signal, redirect: 'manual' });
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        throw upstreamError(`HEPData request timed out: ${url}`);
      }
      throw upstreamError(`HEPData request failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    // Handle manual redirects with SSRF defense (B-3)
    if (response.status >= 301 && response.status <= 308) {
      if (redirectCount >= MAX_REDIRECTS) {
        throw upstreamError(`HEPData redirect limit (${MAX_REDIRECTS}) exceeded`);
      }
      const location = response.headers.get('location');
      if (!location) throw upstreamError('HEPData redirect missing Location header');
      const safeLocation = validateHepdataRedirectTarget(location, url);
      return this.fetchWithRetry(safeLocation, init, signal, attempt, startTime, redirectCount + 1);
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
      return this.fetchWithRetry(url, init, signal, attempt + 1, startTime, redirectCount);
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
