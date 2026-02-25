/**
 * H-19: retryWithBackoff — exponential backoff retry utility.
 *
 * Uses McpError.retryable to decide whether to retry. If the error
 * specifies retryAfterMs (e.g., RATE_LIMIT), that value overrides
 * the computed backoff delay.
 */

import { McpError, type RetryPolicy, DEFAULT_RETRY_POLICY } from '@autoresearch/shared';

export interface RetryAttempt {
  attempt: number;
  error: unknown;
  delayMs: number;
}

export interface RetryResult<T> {
  value: T;
  attempts: RetryAttempt[];
}

function computeDelay(attempt: number, policy: RetryPolicy): number {
  const expDelay = Math.min(policy.baseDelayMs * 2 ** attempt, policy.maxDelayMs);
  if (policy.jitter <= 0) return expDelay;
  const jitterRange = expDelay * policy.jitter;
  return expDelay - jitterRange + Math.random() * jitterRange;
}

function isRetryable(err: unknown): { retryable: boolean; retryAfterMs?: number } {
  if (err instanceof McpError) {
    return { retryable: err.retryable, retryAfterMs: err.retryAfterMs };
  }
  return { retryable: false };
}

/**
 * Retry an async function with exponential backoff.
 *
 * - Only retries errors where McpError.retryable === true.
 * - RATE_LIMIT errors with retryAfterMs override computed backoff.
 * - Non-retryable errors are thrown immediately.
 * - After maxRetries exhausted, throws a RetryExhaustedError containing all attempts.
 */
export async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  policy: RetryPolicy = DEFAULT_RETRY_POLICY,
): Promise<RetryResult<T>> {
  const attempts: RetryAttempt[] = [];

  for (let attempt = 0; attempt <= policy.maxRetries; attempt++) {
    try {
      const value = await fn();
      return { value, attempts };
    } catch (err: unknown) {
      const { retryable, retryAfterMs } = isRetryable(err);

      if (!retryable || attempt >= policy.maxRetries) {
        // Not retryable or exhausted — attach history and throw
        const message = err instanceof Error ? err.message : String(err);
        throw new RetryExhaustedError(
          `Retry exhausted after ${attempt + 1} attempt(s): ${message}`,
          err,
          attempts,
        );
      }

      const delayMs = retryAfterMs ?? computeDelay(attempt, policy);
      attempts.push({ attempt, error: err, delayMs });
      await sleep(delayMs);
    }
  }

  // Unreachable, but TypeScript needs it
  throw new Error('Unreachable');
}

export class RetryExhaustedError extends Error {
  constructor(
    message: string,
    public readonly lastError: unknown,
    public readonly attempts: RetryAttempt[],
  ) {
    super(message);
    this.name = 'RetryExhaustedError';
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, Math.max(0, ms)));
}
