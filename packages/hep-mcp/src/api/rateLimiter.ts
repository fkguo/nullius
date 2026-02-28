// ─────────────────────────────────────────────────────────────────────────────
// Rate Limiter Constants
// ─────────────────────────────────────────────────────────────────────────────

import { logger } from '../utils/logger.js';

// INSPIRE API rate limit: 15 requests per 5s window
// On 429, must wait at least 5 seconds before retrying
// Reference: https://github.com/inspirehep/rest-api-doc
export const BACKOFF_BASE_DELAY_MS = 5000;  // 5 seconds (per INSPIRE API docs)
export const BACKOFF_MAX_DELAY_MS = 30000;
export const MAX_RETRY_ATTEMPTS = 3;
export const REQUEST_TIMEOUT_MS = 30000; // 30 second timeout

// Proactive rate limiting (R-002)
const INSPIRE_RATE_LIMIT = 15;        // Max requests per window
const INSPIRE_RATE_WINDOW_MS = 5000;  // 5 second window

// Network errors that should trigger retry
const RETRYABLE_ERROR_CODES = ['ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED'];

// Circuit breaker constants
const CIRCUIT_FAILURE_THRESHOLD = 5;
const CIRCUIT_RESET_TIMEOUT_MS = 60000; // 60 seconds

function isTestEnv(): boolean {
  return Boolean(
    process.env.VITEST
      || process.env.VITEST_WORKER_ID
      || process.env.VITEST_POOL_ID
      || process.env.NODE_ENV === 'test'
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Circuit Breaker (P2-1)
// ─────────────────────────────────────────────────────────────────────────────

type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

class CircuitBreaker {
  private state: CircuitState = 'CLOSED';
  private failureCount = 0;
  private lastFailureTime = 0;

  async execute<T>(fn: () => Promise<T>): Promise<T> {
    if (this.state === 'OPEN') {
      if (Date.now() - this.lastFailureTime > CIRCUIT_RESET_TIMEOUT_MS) {
        this.state = 'HALF_OPEN';
        logger.debug('circuit_breaker', 'State: HALF_OPEN (testing)');
      } else {
        throw new Error('CircuitBreakerOpen: INSPIRE API temporarily unavailable');
      }
    }

    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure();
      throw error;
    }
  }

  private onSuccess(): void {
    if (this.state === 'HALF_OPEN') {
      logger.debug('circuit_breaker', 'State: CLOSED (recovered)');
    }
    this.failureCount = 0;
    this.state = 'CLOSED';
  }

  private onFailure(): void {
    this.failureCount++;
    this.lastFailureTime = Date.now();
    if (this.failureCount >= CIRCUIT_FAILURE_THRESHOLD) {
      this.state = 'OPEN';
      logger.warn(`Circuit breaker: OPEN`, { failure_count: this.failureCount });
    }
  }

  getState(): CircuitState {
    return this.state;
  }

  getFailureCount(): number {
    return this.failureCount;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Sliding Window Rate Limiter (R-002)
// ─────────────────────────────────────────────────────────────────────────────

class SlidingWindowLimiter {
  private timestamps: number[] = [];
  private readonly maxRequests: number;
  private readonly windowMs: number;

  constructor(maxRequests: number, windowMs: number) {
    this.maxRequests = maxRequests;
    this.windowMs = windowMs;
  }

  async acquire(): Promise<void> {
    if (isTestEnv()) return;
    const now = Date.now();
    // Remove timestamps outside the window
    this.timestamps = this.timestamps.filter(t => now - t < this.windowMs);

    if (this.timestamps.length >= this.maxRequests) {
      // Wait until the oldest request exits the window
      const oldestTimestamp = this.timestamps[0];
      const waitTime = this.windowMs - (now - oldestTimestamp) + 10; // +10ms buffer
      if (waitTime > 0) {
        await this.sleep(waitTime);
      }
      // Clean up again after waiting
      this.timestamps = this.timestamps.filter(t => Date.now() - t < this.windowMs);
    }

    this.timestamps.push(Date.now());
  }

  private sleep(ms: number): Promise<void> {
    if (isTestEnv()) return Promise.resolve();
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Rate Limiter Class
// ─────────────────────────────────────────────────────────────────────────────

export class InspireRateLimiter {
  private static instance: InspireRateLimiter | null = null;
  private activeRetries = 0;
  private slidingWindow: SlidingWindowLimiter;
  private circuitBreaker: CircuitBreaker;

  private constructor() {
    this.slidingWindow = new SlidingWindowLimiter(INSPIRE_RATE_LIMIT, INSPIRE_RATE_WINDOW_MS);
    this.circuitBreaker = new CircuitBreaker();
  }

  static getInstance(): InspireRateLimiter {
    if (!InspireRateLimiter.instance) {
      InspireRateLimiter.instance = new InspireRateLimiter();
    }
    return InspireRateLimiter.instance;
  }

  private calculateBackoffDelay(retryCount: number): number {
    const delay = BACKOFF_BASE_DELAY_MS * Math.pow(2, retryCount);
    const jitter = delay * 0.25 * (Math.random() * 2 - 1);
    return Math.min(delay + jitter, BACKOFF_MAX_DELAY_MS);
  }

  async fetch(
    url: string,
    options?: RequestInit & { signal?: AbortSignal }
  ): Promise<Response> {
    // Circuit breaker check (P2-1)
    return this.circuitBreaker.execute(async () => {
      // Proactive rate limiting (R-002)
      await this.slidingWindow.acquire();

      let timeout: ReturnType<typeof setTimeout> | undefined;
      let signal: AbortSignal;

      if (options?.signal) {
        signal = options.signal;
      } else {
        const timeoutController = new AbortController();
        timeout = setTimeout(() => timeoutController.abort(), REQUEST_TIMEOUT_MS);
        signal = timeoutController.signal;
      }

      const fetchOptions = { ...options, signal };

      try {
        return await this.executeWithRetry(url, fetchOptions, 0);
      } finally {
        if (timeout) clearTimeout(timeout);
      }
    });
  }

  private async executeWithRetry(
    url: string,
    options: RequestInit | undefined,
    retryCount: number
  ): Promise<Response> {
    try {
      const response = await fetch(url, options);

      if (response.status === 429) {
        if (retryCount >= MAX_RETRY_ATTEMPTS) {
          logger.error(`Rate limit: Max retries exceeded`, { url, retry_count: retryCount });
          return response;
        }

        this.activeRetries++;

        const retryAfter = response.headers.get('Retry-After');
        const delay = retryAfter
          ? parseInt(retryAfter, 10) * 1000 || this.calculateBackoffDelay(retryCount)
          : this.calculateBackoffDelay(retryCount);

        logger.debug('rate_limiter', `429 received, retrying`, { retry_count: retryCount + 1, delay_ms: Math.round(delay) });

        await this.sleep(delay);
        this.activeRetries--;

        return this.executeWithRetry(url, options, retryCount + 1);
      }

      return response;
    } catch (err) {
      // Don't retry abort errors
      if (err && typeof err === 'object' && (err as Error).name === 'AbortError') {
        throw err;
      }

      // Check if this is a retryable network error
      const errorCode = (err as NodeJS.ErrnoException)?.code;
      if (errorCode && RETRYABLE_ERROR_CODES.includes(errorCode)) {
        if (retryCount >= MAX_RETRY_ATTEMPTS) {
          logger.error(`Network error: Max retries exceeded`, { url, error_code: errorCode, retry_count: retryCount });
          throw err;
        }

        const delay = this.calculateBackoffDelay(retryCount);
        logger.debug('rate_limiter', `Network error, retrying`, { error_code: errorCode, retry_count: retryCount + 1, delay_ms: Math.round(delay) });

        await this.sleep(delay);
        return this.executeWithRetry(url, options, retryCount + 1);
      }

      throw err;
    }
  }

  private sleep(ms: number): Promise<void> {
    if (isTestEnv()) return Promise.resolve();
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Convenience Function
// ─────────────────────────────────────────────────────────────────────────────

export function inspireFetch(
  url: string,
  options?: RequestInit & { signal?: AbortSignal }
): Promise<Response> {
  return InspireRateLimiter.getInstance().fetch(url, options);
}
