/**
 * M-14a: redaction + H-13: constants — unit tests for Batch 4 shared additions.
 */

import { describe, it, expect } from 'vitest';
import {
  redact,
  MAX_INLINE_RESULT_BYTES,
  HARD_CAP_RESULT_BYTES,
} from '../index.js';

// ─────────────────────────────────────────────────────────────────────────────
// M-14a: redact()
// ─────────────────────────────────────────────────────────────────────────────

describe('M-14a: redact', () => {
  it('redacts sk- API keys', () => {
    const input = 'Error with key sk-abc123456789012345678901';
    const result = redact(input);
    expect(result).toBe('Error with key sk-***');
    expect(result).not.toContain('abc123456789');
  });

  it('redacts key- prefixed tokens', () => {
    const input = 'using key-xxxxxxxxxxxxxxxxxxxxxxxxxx';
    const result = redact(input);
    expect(result).toBe('using key-***');
  });

  it('redacts Bearer tokens', () => {
    const input = 'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig';
    const result = redact(input);
    expect(result).toContain('Bearer ***');
    expect(result).not.toContain('eyJhbGciOiJIUzI1NiJ9');
  });

  it('redacts macOS user paths', () => {
    const input = 'Error at /Users/john/projects/test.ts';
    const result = redact(input);
    expect(result).toBe('Error at /Users/<redacted>/projects/test.ts');
  });

  it('redacts Linux user paths', () => {
    const input = 'File /home/ubuntu/data/file.json';
    const result = redact(input);
    expect(result).toBe('File /home/<redacted>/data/file.json');
  });

  it('preserves non-sensitive text', () => {
    const input = 'Normal log message with no secrets';
    expect(redact(input)).toBe(input);
  });

  it('handles multiple patterns in one string', () => {
    const input = 'key at /Users/bob/app sk-longkeylongkeylongkeylongkey';
    const result = redact(input);
    expect(result).toContain('/Users/<redacted>/');
    expect(result).toContain('sk-***');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// H-13: Constants
// ─────────────────────────────────────────────────────────────────────────────

describe('H-13: result size constants', () => {
  it('exports MAX_INLINE_RESULT_BYTES = 40_000', () => {
    expect(MAX_INLINE_RESULT_BYTES).toBe(40_000);
  });

  it('exports HARD_CAP_RESULT_BYTES = 80_000', () => {
    expect(HARD_CAP_RESULT_BYTES).toBe(80_000);
  });

  it('hard cap > soft limit', () => {
    expect(HARD_CAP_RESULT_BYTES).toBeGreaterThan(MAX_INLINE_RESULT_BYTES);
  });
});
