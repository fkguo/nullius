/**
 * H-01 + H-02 + H-19 unit tests for shared package additions.
 */

import { describe, it, expect } from 'vitest';
import {
  McpError,
  invalidParams,
  notFound,
  rateLimit,
  upstreamError,
  internalError,
  unsafeFs,
} from '../errors.js';
import { generateTraceId, extractTraceId } from '../tracing.js';
import { DEFAULT_RETRY_POLICY } from '../retry-policy.js';
import type { RetryPolicy } from '../retry-policy.js';

// ── H-01: McpError retryable ────────────────────────────────────────────────

describe('McpError retryable (H-01)', () => {
  it('RATE_LIMIT is retryable', () => {
    const err = new McpError('RATE_LIMIT', 'too fast');
    expect(err.retryable).toBe(true);
  });

  it('RATE_LIMIT with retryAfter extracts retryAfterMs', () => {
    const err = rateLimit('slow down', 5000);
    expect(err.retryable).toBe(true);
    expect(err.retryAfterMs).toBe(5000);
  });

  it('RATE_LIMIT without retryAfter has undefined retryAfterMs', () => {
    const err = rateLimit('slow down');
    expect(err.retryable).toBe(true);
    expect(err.retryAfterMs).toBeUndefined();
  });

  it('UPSTREAM_ERROR is retryable', () => {
    const err = upstreamError('server error');
    expect(err.retryable).toBe(true);
    expect(err.retryAfterMs).toBeUndefined();
  });

  it('INVALID_PARAMS is not retryable', () => {
    const err = invalidParams('bad input');
    expect(err.retryable).toBe(false);
  });

  it('NOT_FOUND is not retryable', () => {
    const err = notFound('missing');
    expect(err.retryable).toBe(false);
  });

  it('INTERNAL_ERROR is not retryable', () => {
    const err = internalError('oops');
    expect(err.retryable).toBe(false);
  });

  it('UNSAFE_FS is not retryable', () => {
    const err = unsafeFs('bad path');
    expect(err.retryable).toBe(false);
  });

  it('toJSON includes retryable', () => {
    const err = rateLimit('slow', 1000);
    const json = err.toJSON();
    expect(json.retryable).toBe(true);
    expect(json.retryAfterMs).toBe(1000);
  });

  it('toJSON omits retryAfterMs when undefined', () => {
    const err = invalidParams('bad');
    const json = err.toJSON();
    expect(json.retryable).toBe(false);
    expect('retryAfterMs' in json).toBe(false);
  });
});

// ── H-02: trace_id ──────────────────────────────────────────────────────────

describe('trace_id (H-02)', () => {
  it('generateTraceId returns UUID v4 format', () => {
    const id = generateTraceId();
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('generateTraceId returns unique values', () => {
    const ids = new Set(Array.from({ length: 100 }, () => generateTraceId()));
    expect(ids.size).toBe(100);
  });

  it('extractTraceId uses provided _trace_id', () => {
    const { traceId, params } = extractTraceId({ _trace_id: 'custom-id', foo: 'bar' });
    expect(traceId).toBe('custom-id');
    expect(params).toEqual({ foo: 'bar' });
    expect('_trace_id' in params).toBe(false);
  });

  it('extractTraceId generates new ID when _trace_id missing', () => {
    const { traceId, params } = extractTraceId({ foo: 'bar' });
    expect(traceId).toMatch(/^[0-9a-f]{8}-/);
    expect(params).toEqual({ foo: 'bar' });
  });

  it('extractTraceId generates new ID when _trace_id is empty', () => {
    const { traceId } = extractTraceId({ _trace_id: '  ' });
    expect(traceId).toMatch(/^[0-9a-f]{8}-/);
  });
});

// ── H-19: RetryPolicy type ──────────────────────────────────────────────────

describe('RetryPolicy (H-19)', () => {
  it('DEFAULT_RETRY_POLICY matches ECOSYSTEM_DEV_CONTRACT', () => {
    expect(DEFAULT_RETRY_POLICY.maxRetries).toBe(3);
    expect(DEFAULT_RETRY_POLICY.baseDelayMs).toBe(1000);
    expect(DEFAULT_RETRY_POLICY.maxDelayMs).toBe(60_000);
    expect(DEFAULT_RETRY_POLICY.jitter).toBe(0.25);
  });

  it('RetryPolicy type is structurally valid', () => {
    const policy: RetryPolicy = {
      maxRetries: 5,
      baseDelayMs: 500,
      maxDelayMs: 10_000,
      jitter: 0.5,
    };
    expect(policy.maxRetries).toBe(5);
  });
});
