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
const MAX_RETRIES = 3;
const SHARED_GATE_LOCK_POLL_MS = 100;
const SHARED_GATE_STALE_MS = 60_000;

function isTestEnv(): boolean {
  return Boolean(
    process.env.VITEST
      || process.env.VITEST_WORKER_ID
      || process.env.VITEST_POOL_ID
      || process.env.NODE_ENV === 'test'
  );
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
  ): Promise<Response> {
    let response: Response;
    try {
      response = await fetch(url, { ...options, signal });
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        throw upstreamError(`arXiv request aborted: ${url}`);
      }
      throw upstreamError(`arXiv request failed: ${err instanceof Error ? err.message : String(err)}`);
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
      return this.fetchWithRetry(url, options, signal, attempt + 1, startTime, enforceTimeoutBudget);
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
 */
export async function arxivFetch(
  url: string,
  options?: RequestInit & { signal?: AbortSignal }
): Promise<Response> {
  return arxivLimiter.fetch(url, options);
}
