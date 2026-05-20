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
// Env-config helpers (must precede const declarations that use them)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Parse a positive-integer env var. Falls back to `fallback` when the var
 * is unset, empty, non-numeric, non-finite, negative, zero, or non-integer.
 * Returns `Math.floor(parsed)` for fractional values that are otherwise
 * valid.
 *
 * Sanitizes against malicious / buggy env (e.g. "abc", "-1", "1e999",
 * "NaN") so a misconfigured environment cannot disable the rate-limiter
 * or set absurd timeouts.
 */
function parseEnvPositiveInt(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
}

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

// Defaults below are tunable via env. Raised REQUEST_TIMEOUT_MS default from
// 30s to 90s because source/PDF downloads + retry-after waits routinely
// exceeded 30s (arXiv tightened rate limits post 2026-02; multi-retry chains
// with retry-after=10s each blow the old budget). See parseEnvPositiveInt
// for sanitization rules.
const ARXIV_MIN_INTERVAL_MS = parseEnvPositiveInt('ARXIV_MIN_INTERVAL_MS', 3000);
const REQUEST_TIMEOUT_MS = parseEnvPositiveInt('ARXIV_REQUEST_TIMEOUT_MS', 90_000);
const DEFAULT_RETRY_AFTER_MS = 10_000;
const NETWORK_RETRY_BASE_MS = 1_000;
const NETWORK_RETRY_MAX_MS = 10_000;
const MAX_RETRIES = parseEnvPositiveInt('ARXIV_MAX_RETRIES', 3);
const MAX_REDIRECTS = 5;
const SHARED_GATE_LOCK_POLL_MS = 100;
const SHARED_GATE_STALE_MS = 60_000;
// Absolute ceiling on `backoff-until-ms` writes. Prevents a malicious /
// buggy upstream Retry-After value (e.g. "999999999") from parking the
// entire pool forever. 10 minutes is generous for transient arXiv throttle
// while still bounded.
const MAX_BACKOFF_MS = 10 * 60 * 1000;
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

function getSharedGatePaths(): {
  stateDir: string;
  lockDir: string;
  timestampFile: string;
  backoffFile: string;
} {
  const stateDir = path.join(getArxivDataDir(), 'rate-limit');
  return {
    stateDir,
    lockDir: path.join(stateDir, 'api-query.lock'),
    timestampFile: path.join(stateDir, 'api-query.last-acquire-ms'),
    // Cross-process 429 backoff: when any process receives HTTP 429 from
    // arXiv, it writes `Date.now() + retryAfterMs` here. Other processes
    // trying to acquire the shared gate wait until this deadline,
    // preventing the multi-agent amplification pattern where each process
    // independently burns its retry budget on the same throttle window.
    backoffFile: path.join(stateDir, 'api-query.backoff-until-ms'),
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

/**
 * Read the cross-process backoff deadline (epoch ms). Returns 0 when the
 * file is absent or malformed. Returns 0 for past deadlines so callers can
 * compute `max(0, deadline - now)` without branching.
 */
async function readBackoffUntilMs(backoffFile: string): Promise<number> {
  try {
    const raw = await fs.readFile(backoffFile, 'utf-8');
    const parsed = Number(raw.trim());
    if (!Number.isFinite(parsed) || parsed <= 0) return 0;
    return parsed;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw err;
  }
}

/**
 * Write a cross-process backoff deadline. Caps at `now + MAX_BACKOFF_MS`
 * to defend against a hostile / buggy upstream returning an absurd
 * Retry-After (e.g. "999999999"). Only advances the existing deadline —
 * never shortens it (a different process's later 429 might already have
 * pushed the deadline further).
 */
async function writeBackoffUntilMs(backoffFile: string, deadlineMs: number): Promise<void> {
  if (!Number.isFinite(deadlineMs) || deadlineMs <= 0) return;
  const capped = Math.min(deadlineMs, Date.now() + MAX_BACKOFF_MS);
  await fs.mkdir(path.dirname(backoffFile), { recursive: true });
  // Best-effort: read current value, write the max. Race window between
  // read+write is acceptable (worst case: we under-advance by a few ms; the
  // other writer's deadline survives because it was just written).
  const current = await readBackoffUntilMs(backoffFile);
  const next = Math.max(current, capped);
  if (next > current) {
    await fs.writeFile(backoffFile, String(next), 'utf-8');
  }
}

async function acquireSharedIntervalGate(signal?: AbortSignal): Promise<void> {
  if (isTestEnv()) return;

  const { timestampFile, backoffFile } = getSharedGatePaths();
  const releaseLock = await acquireSharedGateLock(signal);

  try {
    const lastAcquireMs = await readLastAcquireMs(timestampFile);
    const minIntervalWaitMs = Math.max(ARXIV_MIN_INTERVAL_MS - (Date.now() - lastAcquireMs), 0);
    // Cross-process 429 backoff: if a peer recently received HTTP 429,
    // wait until its retry-after deadline before allowing the next fetch.
    const backoffUntilMs = await readBackoffUntilMs(backoffFile);
    const backoffWaitMs = Math.max(backoffUntilMs - Date.now(), 0);
    const waitMs = Math.max(minIntervalWaitMs, backoffWaitMs);
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

/**
 * Record a cross-process 429 backoff deadline so subsequent acquires
 * (from any process) wait at least until `now + retryAfterMs`. Skipped in
 * test env. Best-effort: failure to write the file is logged via stderr
 * but does not break the in-flight retry path.
 */
async function recordSharedBackoff(retryAfterMs: number): Promise<void> {
  if (isTestEnv()) return;
  if (!Number.isFinite(retryAfterMs) || retryAfterMs <= 0) return;
  const { backoffFile } = getSharedGatePaths();
  try {
    await writeBackoffUntilMs(backoffFile, Date.now() + retryAfterMs);
  } catch (err) {
    // Best-effort — file-system error here should not turn into a tool
    // failure. Surface to stderr for operator visibility.
    process.stderr.write(
      `[arxiv-mcp] warning: failed to record 429 backoff (${err instanceof Error ? err.message : String(err)})\n`,
    );
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
      // Cross-process 429 backoff (P0-hotfix): record the retry-after
      // deadline to the shared file so peer processes wait for it before
      // their next acquire. Best-effort; failure to write the file is
      // logged but does not break this retry path.
      await recordSharedBackoff(retryAfterMs);
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
      const retryAfterMs = parseRetryAfterMs(response.headers.get('retry-after'));
      // Terminal 429: still record the backoff so peers don't immediately
      // hammer arXiv after this process gives up.
      if (retryAfterMs !== null && retryAfterMs !== undefined) {
        await recordSharedBackoff(retryAfterMs);
      }
      throw rateLimit('arXiv rate limit exceeded', retryAfterMs);
    }

    return response;
  }
}

const arxivLimiter = new ArxivRateLimiter();

// ─────────────────────────────────────────────────────────────────────────────
// Internal helpers exposed for unit testing (P0-hotfix).
// Not part of the public package surface; consumers should not import these.
// ─────────────────────────────────────────────────────────────────────────────
export const __testing__ = {
  parseEnvPositiveInt,
  readBackoffUntilMs,
  writeBackoffUntilMs,
  recordSharedBackoff,
  getSharedGatePaths,
  MAX_BACKOFF_MS,
};

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
