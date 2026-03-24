import { describe, expect, it, vi } from 'vitest';
import {
  parseRetryAfterMs,
  SerialIntervalGate,
  SerialTaskQueue,
  sleepWithAbort,
} from '../utils/rateLimit.js';

describe('parseRetryAfterMs', () => {
  it('parses numeric seconds', () => {
    expect(parseRetryAfterMs('6')).toBe(6000);
  });

  it('parses HTTP-date values', () => {
    const now = Date.parse('2026-03-24T03:00:00Z');
    expect(parseRetryAfterMs('Tue, 24 Mar 2026 03:00:05 GMT', now)).toBe(5000);
  });

  it('returns zero for past HTTP-date values', () => {
    const now = Date.parse('2026-03-24T03:00:10Z');
    expect(parseRetryAfterMs('Tue, 24 Mar 2026 03:00:05 GMT', now)).toBe(0);
  });

  it('returns undefined for invalid values', () => {
    expect(parseRetryAfterMs(null)).toBeUndefined();
    expect(parseRetryAfterMs('')).toBeUndefined();
    expect(parseRetryAfterMs('not-a-date')).toBeUndefined();
  });
});

describe('sleepWithAbort', () => {
  it('rejects with caller-provided error when aborted', async () => {
    const controller = new AbortController();
    const promise = sleepWithAbort(1000, controller.signal, () => new Error('aborted'));
    controller.abort();
    await expect(promise).rejects.toThrow('aborted');
  });
});

describe('SerialTaskQueue', () => {
  it('serializes concurrent tasks', async () => {
    const queue = new SerialTaskQueue();
    const events: string[] = [];

    const first = queue.run(async () => {
      events.push('first:start');
      await new Promise<void>(resolve => setTimeout(resolve, 10));
      events.push('first:end');
    });

    const second = queue.run(async () => {
      events.push('second:start');
      events.push('second:end');
    });

    await Promise.all([first, second]);
    expect(events).toEqual(['first:start', 'first:end', 'second:start', 'second:end']);
  });
});

describe('SerialIntervalGate', () => {
  it('enforces interval between acquires', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-24T03:00:00Z'));

    const gate = new SerialIntervalGate(100);
    await gate.acquire();

    let finished = false;
    const second = gate.acquire().then(() => {
      finished = true;
    });

    await vi.advanceTimersByTimeAsync(99);
    expect(finished).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await second;
    expect(finished).toBe(true);

    vi.useRealTimers();
  });
});
