import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import {
  parseRetryAfterMs,
  rateLimit,
  SerialIntervalGate,
  sleepWithAbort,
  upstreamError,
} from '@autoresearch/shared';

/**
 * arXiv API Rate Limiter
 *
 * arXiv requires at least 3 seconds between requests.
 * Reference: https://arxiv.org/help/api/user-manual
 */

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const ARXIV_MIN_INTERVAL_MS = 3000;
const REQUEST_TIMEOUT_MS = 30000;
const DEFAULT_RETRY_AFTER_MS = 10_000;
const NETWORK_RETRY_BASE_MS = 1_000;
const NETWORK_RETRY_MAX_MS = 10_000;
const MAX_RETRIES = 3;
const MAX_REDIRECTS = 5;
const SHARED_GATE_LOCK_POLL_MS = 100;
const SHARED_GATE_STALE_MS = 60_000;
const RETRYABLE_NETWORK_ERROR_CODES = new Set([
  'ECONNRESET',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ECONNREFUSED',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_SOCKET',
]);

/**
 * H-10 SSRF defense: only fetch and only follow redirects to the arXiv
 * `export.arxiv.org` host. Without this, the default `redirect: 'follow'`
 * lets Node fetch follow up to 20 redirects to any host, and the exported
 * `arxivFetch(url)` accepts arbitrary URL strings at the public surface.
 *
 * Verified the sole live fetch target is `https://export.arxiv.org` — all
 * internal callers (paperFetcher.ts, paperContent.ts, arxivSource.ts,
 * searchClient.ts) build URLs rooted at `ARXIV_EXPORT_BASE`. `arxiv.org`
 * (e.g. `https://arxiv.org/abs/<id>`) appears only as a tool-output URL
 * string (downloadUrls.ts) — never fetched by this package today.
 */
const ARXIV_ALLOWED_HOSTS: ReadonlySet<string> = new Set([
  'export.arxiv.org',
]);

function isTestEnv(): boolean {
  return Boolean(
    process.env.VITEST
      || process.env.VITEST_WORKER_ID
      || process.env.VITEST_POOL_ID
      || process.env.NODE_ENV === 'test'
  );
}

/**
 * Validate that a URL is safe for arXiv fetch — used at the public
 * `arxivFetch()` entry point as a defense-in-depth gate against external
 * callers passing arbitrary URLs.
 *
 * Rules (H-10):
 *   1. URL must parse.
 *   2. Scheme must be `https:`.
 *   3. Hostname must be in `ARXIV_ALLOWED_HOSTS`.
 */
function validateArxivEntryUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw upstreamError(`arXiv fetch rejected (not a parseable URL): ${url}`);
  }
  if (parsed.protocol !== 'https:') {
    throw upstreamError(`arXiv fetch rejected (non-https scheme): ${parsed.protocol}`);
  }
  if (!ARXIV_ALLOWED_HOSTS.has(parsed.hostname)) {
    throw upstreamError(`arXiv fetch rejected (host not in allow-list): ${parsed.hostname}`);
  }
}

/**
 * Validate a redirect target. Returns the absolute URL string on success, or
 * throws an upstream error on policy violation. Same shape as the entry
 * validator but resolves relative URLs against `currentUrl`.
 */
function validateArxivRedirectTarget(location: string, currentUrl: string): string {
  let target: URL;
  try {
    target = new URL(location, currentUrl);
  } catch {
    throw upstreamError(`arXiv redirect Location is not a parseable URL: ${location}`);
  }
  if (target.protocol !== 'https:') {
    throw upstreamError(`arXiv redirect blocked (non-https scheme): ${target.protocol}`);
  }
  if (!ARXIV_ALLOWED_HOSTS.has(target.hostname)) {
    throw upstreamError(`arXiv redirect blocked (host not in allow-list): ${target.hostname}`);
  }
  return target.toString();
}

function getArxivDataDir(): string {
  return process.env.ARXIV_DATA_DIR || path.join(os.tmpdir(), 'arxiv-mcp-data');
}

function getSharedGatePaths(): { stateDir: string; lockDir: string; timestampFile: string } {
  const stateDir = path.join(getArxivDataDir(), 'rate-limit');
  return {
    stateDir,
    lockDir: path.join(stateDir, 'api-query.lock'),
    timestampFile: path.join(stateDir, 'api-query.last-acquire-ms'),
  };
}

async function waitForDelay(
  delayMs: number,
  signal: AbortSignal | undefined,
  onAbort: () => Error,
): Promise<void> {
  if (delayMs <= 0) return;
  if (signal) {
    await sleepWithAbort(delayMs, signal, onAbort);
    return;
  }
  await new Promise<void>(resolve => setTimeout(resolve, delayMs));
}

function getErrorCause(err: unknown): unknown {
  return err instanceof Error ? err.cause : undefined;
}

function getErrorCode(err: unknown): string | undefined {
  if (!err || typeof err !== 'object') return undefined;
  const code = (err as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

function formatFetchFailure(err: unknown): { message: string; data: Record<string, unknown> } {
  const message = err instanceof Error ? err.message : String(err);
  const cause = getErrorCause(err);
  const causeMessage = cause instanceof Error ? cause.message : cause ? String(cause) : undefined;
  const code = getErrorCode(err) ?? getErrorCode(cause);

  return {
    message: causeMessage ? `${message} (cause: ${causeMessage})` : message,
    data: {
      ...(code ? { code } : {}),
      ...(causeMessage ? { cause: causeMessage } : {}),
    },
  };
}

function isRetryableFetchError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  const cause = getErrorCause(err);
  const code = getErrorCode(err) ?? getErrorCode(cause);
  return Boolean(
    (code && RETRYABLE_NETWORK_ERROR_CODES.has(code))
      || message === 'fetch failed'
  );
}

function networkRetryDelayMs(attempt: number): number {
  return Math.min(NETWORK_RETRY_BASE_MS * Math.pow(2, attempt), NETWORK_RETRY_MAX_MS);
}

async function isSharedLockStale(lockDir: string): Promise<boolean> {
  try {
    const stat = await fs.stat(lockDir);
    return Date.now() - stat.mtimeMs > SHARED_GATE_STALE_MS;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
}

async function acquireSharedGateLock(signal?: AbortSignal): Promise<() => Promise<void>> {
  const { stateDir, lockDir } = getSharedGatePaths();
  await fs.mkdir(stateDir, { recursive: true });

  while (true) {
    try {
      await fs.mkdir(lockDir);
      return async () => {
        await fs.rm(lockDir, { recursive: true, force: true });
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw err;
      }

      if (await isSharedLockStale(lockDir)) {
        await fs.rm(lockDir, { recursive: true, force: true });
        continue;
      }

      await waitForDelay(
        SHARED_GATE_LOCK_POLL_MS,
        signal,
        () => upstreamError('arXiv request aborted while waiting for shared rate-limit lock'),
      );
    }
  }
}

async function readLastAcquireMs(timestampFile: string): Promise<number> {
  try {
    const raw = await fs.readFile(timestampFile, 'utf-8');
    const parsed = Number(raw.trim());
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw err;
  }
}

async function acquireSharedIntervalGate(signal?: AbortSignal): Promise<void> {
  if (isTestEnv()) return;

  const { timestampFile } = getSharedGatePaths();
  const releaseLock = await acquireSharedGateLock(signal);

  try {
    const lastAcquireMs = await readLastAcquireMs(timestampFile);
    const waitMs = Math.max(ARXIV_MIN_INTERVAL_MS - (Date.now() - lastAcquireMs), 0);
    await waitForDelay(
      waitMs,
      signal,
      () => upstreamError('arXiv request aborted while waiting for shared rate-limit window'),
    );
    await fs.writeFile(timestampFile, String(Date.now()), 'utf-8');
  } finally {
    await releaseLock();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// ArxivRateLimiter
// ─────────────────────────────────────────────────────────────────────────────

class ArxivRateLimiter {
  private readonly intervalGate = new SerialIntervalGate(ARXIV_MIN_INTERVAL_MS, isTestEnv);

  async acquire(signal?: AbortSignal): Promise<void> {
    await this.intervalGate.acquire();
    await acquireSharedIntervalGate(signal);
  }

  async fetch(
    url: string,
    options?: RequestInit & { signal?: AbortSignal }
  ): Promise<Response> {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let signal: AbortSignal;

    if (options?.signal) {
      signal = options.signal;
    } else {
      const controller = new AbortController();
      timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      signal = controller.signal;
    }

    await this.acquire(signal);

    try {
      return await this.fetchWithRetry(
        url,
        options,
        signal,
        0,
        Date.now(),
        !options?.signal,
      );
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  private async fetchWithRetry(
    url: string,
    options: RequestInit | undefined,
    signal: AbortSignal,
    attempt: number,
    startTime: number,
    enforceTimeoutBudget: boolean,
    redirectCount = 0,
  ): Promise<Response> {
    let response: Response;
    try {
      // H-10: manual redirect handling so we can validate each hop against
      // the arXiv host allow-list before following.
      response = await fetch(url, { ...options, signal, redirect: 'manual' });
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        throw upstreamError(`arXiv request aborted: ${url}`);
      }
      if (isRetryableFetchError(err) && attempt < MAX_RETRIES) {
        const retryAfterMs = networkRetryDelayMs(attempt);
        if (!isTestEnv()) {
          if (enforceTimeoutBudget) {
            const remaining = REQUEST_TIMEOUT_MS - (Date.now() - startTime);
            if (retryAfterMs >= remaining) {
              const failure = formatFetchFailure(err);
              throw upstreamError(`arXiv request failed: ${failure.message}`, {
                ...failure.data,
                attempts: attempt + 1,
              });
            }
          }
          await sleepWithAbort(
            retryAfterMs,
            signal,
            () => upstreamError('arXiv request aborted during network retry wait'),
          );
        }
        return this.fetchWithRetry(url, options, signal, attempt + 1, startTime, enforceTimeoutBudget, redirectCount);
      }
      const failure = formatFetchFailure(err);
      throw upstreamError(`arXiv request failed: ${failure.message}`, {
        ...failure.data,
        attempts: attempt + 1,
      });
    }

    // H-10 SSRF defense: manual redirect handler with cap + host allow-list
    if (response.status >= 301 && response.status <= 308) {
      if (redirectCount >= MAX_REDIRECTS) {
        throw upstreamError(`arXiv redirect limit (${MAX_REDIRECTS}) exceeded`);
      }
      const location = response.headers.get('location');
      if (!location) throw upstreamError('arXiv redirect missing Location header');
      const safeLocation = validateArxivRedirectTarget(location, url);
      return this.fetchWithRetry(safeLocation, options, signal, attempt, startTime, enforceTimeoutBudget, redirectCount + 1);
    }

    if (response.status === 429 && attempt < MAX_RETRIES) {
      const retryAfterMs = parseRetryAfterMs(response.headers.get('retry-after')) ?? DEFAULT_RETRY_AFTER_MS;
      if (!isTestEnv()) {
        if (enforceTimeoutBudget) {
          const remaining = REQUEST_TIMEOUT_MS - (Date.now() - startTime);
          if (retryAfterMs >= remaining) {
            throw rateLimit('arXiv rate limit: retry-after exceeds remaining timeout budget', retryAfterMs);
          }
        }
        await sleepWithAbort(
          retryAfterMs,
          signal,
          () => upstreamError('arXiv request aborted during retry wait'),
        );
      }
      return this.fetchWithRetry(url, options, signal, attempt + 1, startTime, enforceTimeoutBudget, redirectCount);
    }

    if (response.status === 429) {
      throw rateLimit(
        'arXiv rate limit exceeded',
        parseRetryAfterMs(response.headers.get('retry-after')),
      );
    }

    return response;
  }
}

const arxivLimiter = new ArxivRateLimiter();

// ─────────────────────────────────────────────────────────────────────────────
// arxivFetch
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Fetch from arXiv API with rate limiting and timeout.
 * arXiv requires at least 3 seconds between requests.
 *
 * H-10: validates URL host before fetching so external callers (this is an
 * exported symbol consumed by hep-mcp via `@autoresearch/arxiv-mcp/tooling`)
 * cannot pass arbitrary URLs through the rate-limited surface.
 */
export async function arxivFetch(
  url: string,
  options?: RequestInit & { signal?: AbortSignal }
): Promise<Response> {
  validateArxivEntryUrl(url);
  return arxivLimiter.fetch(url, options);
}
