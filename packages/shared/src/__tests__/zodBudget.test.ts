import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { optionalBudgetInt, optionalBudgetNumber } from '../utils/zodBudget.js';

describe('optionalBudgetInt', () => {
  it('keeps valid native numbers', () => {
    const schema = z.object({ limit: optionalBudgetInt({ min: 1, max: 50 }) });
    expect(schema.parse({ limit: 25 }).limit).toBe(25);
  });

  it('parses control-character-polluted numeric strings', () => {
    const schema = z.object({ limit: optionalBudgetInt({ min: 1, max: 50 }) });
    expect(schema.parse({ limit: '\r\t25' }).limit).toBe(25);
  });

  it('returns undefined for invalid values without defaults', () => {
    const schema = z.object({
      negative: optionalBudgetInt({ min: 1 }),
      zero: optionalBudgetInt({ min: 1 }),
      fractional: optionalBudgetInt({ min: 1 }),
      oversized: optionalBudgetInt({ min: 1, max: 500 }),
      nanValue: optionalBudgetInt({ min: 1 }),
      alpha: optionalBudgetInt({ min: 1 }),
      nullable: optionalBudgetInt({ min: 1 }),
    });

    const parsed = schema.parse({
      negative: -100,
      zero: 0,
      fractional: 1.5,
      oversized: 999999,
      nanValue: Number('abc'),
      alpha: 'abc',
      nullable: null,
    });

    expect(parsed.negative).toBeUndefined();
    expect(parsed.zero).toBeUndefined();
    expect(parsed.fractional).toBeUndefined();
    expect(parsed.oversized).toBeUndefined();
    expect(parsed.nanValue).toBeUndefined();
    expect(parsed.alpha).toBeUndefined();
    expect(parsed.nullable).toBeUndefined();
  });

  it('falls back to defaults when invalid', () => {
    const schema = z.object({
      max_results: optionalBudgetInt({ min: 1, max: 50 }).default(10),
      start: optionalBudgetInt({ min: 0 }).default(0),
    });

    const parsed = schema.parse({
      max_results: -1,
      start: '\r\t-5',
    });

    expect(parsed.max_results).toBe(10);
    expect(parsed.start).toBe(0);
  });
});

describe('optionalBudgetNumber', () => {
  it('parses valid numeric strings and defaults invalid values', () => {
    const schema = z.object({
      max_size_mb: optionalBudgetNumber({ min: 1, max: 200 }).default(100),
    });

    expect(schema.parse({ max_size_mb: '\n\t12.5' }).max_size_mb).toBe(12.5);
    expect(schema.parse({ max_size_mb: Infinity }).max_size_mb).toBe(100);
  });

  it('rejects malformed or unsupported numeric strings', () => {
    const schema = z.object({
      malformed: optionalBudgetNumber({ min: 1, max: 200 }).default(100),
      scientific: optionalBudgetNumber({ min: 1, max: 200 }).default(100),
    });

    const parsed = schema.parse({
      malformed: '12.3.4',
      scientific: '1e5',
    });

    expect(parsed.malformed).toBe(100);
    expect(parsed.scientific).toBe(100);
  });
});
