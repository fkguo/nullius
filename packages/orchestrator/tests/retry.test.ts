/**
 * H-19: retryWithBackoff unit tests.
 */

import { describe, it, expect } from 'vitest';
import { retryWithBackoff, RetryExhaustedError } from '../src/retry.js';
import { McpError } from '@autoresearch/shared';

describe('retryWithBackoff (H-19)', () => {
  it('returns value on first success', async () => {
    const result = await retryWithBackoff(() => Promise.resolve(42));
    expect(result.value).toBe(42);
    expect(result.attempts).toHaveLength(0);
  });

  it('retries RATE_LIMIT errors', async () => {
    let calls = 0;
    const result = await retryWithBackoff(
      () => {
        calls++;
        if (calls < 3) throw new McpError('RATE_LIMIT', 'slow down');
        return Promise.resolve('ok');
      },
      { maxRetries: 3, baseDelayMs: 1, maxDelayMs: 10, jitter: 0 },
    );
    expect(result.value).toBe('ok');
    expect(calls).toBe(3);
    expect(result.attempts).toHaveLength(2);
  });

  it('retries UPSTREAM_ERROR errors', async () => {
    let calls = 0;
    const result = await retryWithBackoff(
      () => {
        calls++;
        if (calls < 2) throw new McpError('UPSTREAM_ERROR', 'server down');
        return Promise.resolve('ok');
      },
      { maxRetries: 3, baseDelayMs: 1, maxDelayMs: 10, jitter: 0 },
    );
    expect(result.value).toBe('ok');
    expect(calls).toBe(2);
  });

  it('does not retry INVALID_PARAMS', async () => {
    let calls = 0;
    await expect(
      retryWithBackoff(
        () => {
          calls++;
          throw new McpError('INVALID_PARAMS', 'bad input');
        },
        { maxRetries: 3, baseDelayMs: 1, maxDelayMs: 10, jitter: 0 },
      ),
    ).rejects.toThrow(RetryExhaustedError);
    expect(calls).toBe(1);
  });

  it('throws RetryExhaustedError after max retries', async () => {
    let calls = 0;
    try {
      await retryWithBackoff(
        () => {
          calls++;
          throw new McpError('RATE_LIMIT', 'always fails');
        },
        { maxRetries: 2, baseDelayMs: 1, maxDelayMs: 10, jitter: 0 },
      );
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(RetryExhaustedError);
      const retryErr = err as RetryExhaustedError;
      expect(retryErr.attempts).toHaveLength(2);
      expect(retryErr.lastError).toBeInstanceOf(McpError);
      expect(calls).toBe(3); // initial + 2 retries
    }
  });

  it('respects retryAfterMs from RATE_LIMIT', async () => {
    const start = Date.now();
    let calls = 0;
    await retryWithBackoff(
      () => {
        calls++;
        if (calls < 2) throw new McpError('RATE_LIMIT', 'wait', { retryAfter: 50 });
        return Promise.resolve('done');
      },
      { maxRetries: 3, baseDelayMs: 1, maxDelayMs: 10, jitter: 0 },
    );
    const elapsed = Date.now() - start;
    // Should have waited ~50ms, not 1ms baseDelay
    expect(elapsed).toBeGreaterThanOrEqual(40);
  });

  it('does not retry non-McpError', async () => {
    let calls = 0;
    await expect(
      retryWithBackoff(
        () => {
          calls++;
          throw new Error('generic error');
        },
        { maxRetries: 3, baseDelayMs: 1, maxDelayMs: 10, jitter: 0 },
      ),
    ).rejects.toThrow(RetryExhaustedError);
    expect(calls).toBe(1);
  });
});
