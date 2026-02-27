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

function isTestEnv(): boolean {
  return Boolean(
    process.env.VITEST
      || process.env.VITEST_WORKER_ID
      || process.env.VITEST_POOL_ID
      || process.env.NODE_ENV === 'test'
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// ArxivRateLimiter
// ─────────────────────────────────────────────────────────────────────────────

class ArxivRateLimiter {
  private lastRequestTime = 0;

  async acquire(): Promise<void> {
    if (isTestEnv()) return;
    const now = Date.now();
    const elapsed = now - this.lastRequestTime;
    if (elapsed < ARXIV_MIN_INTERVAL_MS) {
      await new Promise<void>(resolve => setTimeout(resolve, ARXIV_MIN_INTERVAL_MS - elapsed));
    }
    this.lastRequestTime = Date.now();
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
  await arxivLimiter.acquire();

  let timeout: ReturnType<typeof setTimeout> | undefined;
  let signal: AbortSignal;

  if (options?.signal) {
    signal = options.signal;
  } else {
    const controller = new AbortController();
    timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    signal = controller.signal;
  }

  try {
    return await fetch(url, { ...options, signal });
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
