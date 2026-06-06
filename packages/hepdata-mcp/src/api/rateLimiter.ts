import {
  parseRetryAfterMs,
  rateLimit,
  SerialIntervalGate,
  sleepWithAbort,
  upstreamError,
} from '@autoresearch/shared';
import { isCloudflareChallenge, reconstructResponse } from './transport/challengeDetect.js';
import { getUrlCache, selectAndRun } from './transport/browserTransport.js';
import type { CachedResponse } from './transport/urlCache.js';

// Package version + repo identity for the contact-honest plain-path User-Agent.
// Hard-coded (not read from package.json) to keep the fetch layer dependency-
// free and avoid a JSON import; bump alongside package.json on release.
const PKG_VERSION = '0.1.0';
const CONTACT_USER_AGENT = `hep-mcp/${PKG_VERSION} (+https://github.com/fkguo/autoresearch-lab)`;

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
 * Whether a request is a cacheable GET. We cache only idempotent GETs (the
 * HEPData read surface). Default method (no `init.method`) is GET per fetch spec.
 */
function isGetRequest(init: RequestInit | undefined): boolean {
  const method = init?.method;
  if (method == null) return true;
  return method.toUpperCase() === 'GET';
}

/** Flatten a `Headers` instance into a plain object for caching. */
function headersToObject(headers: Headers): Record<string, string> {
  const obj: Record<string, string> = {};
  headers.forEach((value, key) => {
    obj[key] = value;
  });
  return obj;
}

/** Rebuild a `Response` from a cached payload (replayable body). */
function responseFromCache(cached: CachedResponse): Response {
  return reconstructResponse(cached.body, cached.status, new Headers(cached.headers));
}

/**
 * Whether a response body is safe to cache as a UTF-8 string. The URL cache
 * stores bodies as text; caching a binary payload (e.g. the ZIP returned by
 * `/download/submission/.../original`) as a string would corrupt it on replay.
 *
 * Allowlist text-like content types (HEPData's JSON/YAML/text read surface).
 * When `content-type` is absent or unrecognized we conservatively decline to
 * cache, so an unlabeled binary is never stringified. The browser fallback only
 * needs to stay rare for the JSON/search/record/table endpoints — which all set
 * `application/json` — so this loses no meaningful cache coverage.
 */
function isTextCacheable(headers: Headers): boolean {
  const ct = headers.get('content-type')?.toLowerCase() ?? '';
  if (!ct) return false;
  return (
    ct.includes('json') ||
    ct.includes('yaml') ||
    ct.includes('xml') ||
    ct.startsWith('text/')
  );
}

/**
 * Inject a contact-identifying User-Agent on the PLAIN fetch path when the
 * caller did not set one. We identify honestly (hep-mcp + repo URL) — we do NOT
 * spoof a browser UA here; the browser fallback (separate path) is what actually
 * runs a browser. Returns a possibly-new `RequestInit`; never mutates `init`.
 */
function withContactUserAgent(init: RequestInit | undefined): RequestInit {
  const headers = new Headers(init?.headers);
  if (!headers.has('user-agent')) {
    headers.set('user-agent', CONTACT_USER_AGENT);
  }
  return { ...init, headers };
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
    const url = `${HEPDATA_BASE_URL}${urlPath}`;

    // Pre-fetch cache: a prior success (plain or browser-solved) for this exact
    // GET URL short-circuits the network entirely, keeping the browser path rare.
    // This is checked BEFORE the rate-limit gate so cache hits are not throttled.
    if (isGetRequest(init)) {
      const cached = getUrlCache().get(url);
      if (cached !== undefined) {
        return responseFromCache(cached);
      }
    }

    await this.intervalGate.acquire();

    const startTime = Date.now();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      return await this.fetchWithRetry(url, init, controller.signal, 0, startTime);
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
      response = await fetch(url, {
        ...withContactUserAgent(init),
        signal,
        redirect: 'manual',
      });
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

    const status = response.status;
    const headers = response.headers;

    // A Cloudflare Managed Challenge ONLY ever arrives as 403/503. For every
    // other status (200 JSON, 200 ZIP download, 404, …) we must NOT consume the
    // body: reading a binary download (`/download/submission/.../original` is a
    // ZIP) as text and re-encoding it would corrupt the bytes. So the non-
    // challenge-eligible path returns the original stream untouched, and we cache
    // only when we can losslessly stringify the body (text content types).
    if (status !== 403 && status !== 503) {
      if (status >= 200 && status < 300 && isGetRequest(init) && isTextCacheable(headers)) {
        const cacheBody = await response.clone().text();
        getUrlCache().set(url, { status, headers: headersToObject(headers), body: cacheBody });
      }
      return response;
    }

    // 403/503: read the body once to decide whether this is a solvable challenge
    // or a genuine error. These statuses are never 2xx, so they are never cached;
    // reconstruct a replayable Response for the non-challenge case so a caller
    // that inspects an error body still works.
    const bodyText = await response.text();

    if (!isCloudflareChallenge(status, headers, bodyText)) {
      return reconstructResponse(bodyText, status, headers);
    }

    // Cloudflare Managed Challenge: plain HTTP cannot pass it. `selectAndRun`
    // enforces the opt-in (HEPDATA_BROWSER_FETCH), runs the (injectable) browser
    // solver through this same gated method, caches success, and otherwise
    // throws a precise remedy-bearing error.
    const solved = await selectAndRun(url, headers);
    return reconstructResponse(solved.body, solved.status, new Headers(solved.headers));
  }
}

export async function hepdataFetch(urlPath: string, init?: RequestInit): Promise<Response> {
  return HEPDataRateLimiter.getInstance().fetch(urlPath, init);
}
