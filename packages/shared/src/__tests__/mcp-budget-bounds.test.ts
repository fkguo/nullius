import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { findBudgetBoundMismatches } from '../mcp-budget-bounds.js';
import { zodToMcpInputSchema } from '../mcp-input-schema.js';
import { optionalBudgetInt, optionalBudgetNumber } from '../utils/zodBudget.js';

const schema = z.object({
  bare: optionalBudgetInt({ min: 1, max: 50 }),
  described: optionalBudgetInt({ min: 1, max: 100000 }).describe('described directly'),
  meta: optionalBudgetInt({ min: 2 }).meta({ description: 'meta directly' }),
  described_twice: optionalBudgetInt({ min: 1, max: 9 }).describe('first').describe('second'),
  defaulted: optionalBudgetInt({ min: 0, max: 10 }).default(3).describe('after default'),
  optional_described: optionalBudgetInt({ max: 7 }).optional().describe('after optional'),
  unbounded: optionalBudgetInt(),
  fraction: optionalBudgetNumber({ min: 0.5, max: 200 }).describe('a number budget'),
  fraction_unbounded: optionalBudgetNumber(),
  nested: z.object({ depth: optionalBudgetInt({ min: 1, max: 5 }).describe('nested') }).optional(),
});

type Properties = Record<string, Record<string, unknown>>;

describe('budget bounds in the published inputSchema', () => {
  it('keeps the declared bounds when .describe() or .meta() is called on the helper result', () => {
    const properties = (zodToMcpInputSchema(schema) as { properties: Properties }).properties;

    expect(properties.bare).toMatchObject({ type: 'integer', minimum: 1, maximum: 50 });
    expect(properties.described).toMatchObject({ type: 'integer', minimum: 1, maximum: 100000, description: 'described directly' });
    expect(properties.meta).toMatchObject({ type: 'integer', minimum: 2, description: 'meta directly' });
    expect(properties.described_twice).toMatchObject({ type: 'integer', minimum: 1, maximum: 9, description: 'second' });
    expect(properties.defaulted).toMatchObject({ type: 'integer', minimum: 0, maximum: 10, default: 3 });
    expect(properties.optional_described).toMatchObject({ type: 'integer', maximum: 7 });
    expect(properties.fraction).toMatchObject({ type: 'number', minimum: 0.5, maximum: 200 });
    expect((properties.nested as { properties: Properties }).properties.depth).toMatchObject({
      type: 'integer',
      minimum: 1,
      maximum: 5,
    });
  });

  it('finds no mismatch in what the converter emits', () => {
    expect(findBudgetBoundMismatches(schema, zodToMcpInputSchema(schema))).toEqual([]);
  });

  it('reports bounds that disagree with the parser, at any depth', () => {
    const json = structuredClone(zodToMcpInputSchema(schema)) as { properties: Properties };
    json.properties.described.minimum = -9007199254740991;
    json.properties.described.maximum = 9007199254740991;
    json.properties.bare.maximum = 51;
    delete json.properties.meta.minimum;
    json.properties.fraction.type = 'integer';
    json.properties.unbounded.type = 'number';
    (json.properties.nested as { properties: Properties }).properties.depth.minimum = 0;

    expect(findBudgetBoundMismatches(schema, json)).toEqual([
      '$.bare: stated maximum 51 is rejected by the parser',
      '$.described: stated minimum -9007199254740991 is rejected by the parser',
      '$.described: stated maximum 9007199254740991 is rejected by the parser',
      '$.meta: no minimum stated, but the parser rejects -9007199254740991',
      '$.unbounded: published as number, but the parser rejects 0.5',
      '$.fraction: published as integer, but the parser accepts 0.5',
      '$.nested.depth: stated minimum 0 is rejected by the parser',
    ]);
  });

  it('reports a range that is narrower than the parser accepts', () => {
    const json = structuredClone(zodToMcpInputSchema(schema)) as { properties: Properties };
    json.properties.bare.minimum = 2;
    json.properties.fraction.maximum = 100;

    expect(findBudgetBoundMismatches(schema, json)).toEqual([
      '$.bare: parser accepts 1, below the stated minimum 2',
      '$.fraction: parser accepts 100.0000001, above the stated maximum 100',
    ]);
  });

  it('tells integer and number apart in ranges below zero', () => {
    const negative = z.object({
      int_range: optionalBudgetInt({ min: -10, max: -5 }),
      number_range: optionalBudgetNumber({ min: -3, max: 0 }),
    });
    const json = structuredClone(zodToMcpInputSchema(negative)) as { properties: Properties };

    expect(findBudgetBoundMismatches(negative, json)).toEqual([]);

    json.properties.int_range.type = 'number';
    json.properties.number_range.type = 'integer';
    expect(findBudgetBoundMismatches(negative, json)).toEqual([
      '$.int_range: published as number, but the parser rejects -5.5',
      '$.number_range: published as integer, but the parser accepts -0.5',
    ]);
  });

  it('checks a budget-style field recognised by structure even without bounds metadata', () => {
    // A preprocess pipe to a number built without the helpers carries no
    // metadata, so the converter publishes zod's generic integer range.
    const bare = z.object({
      limit: z.preprocess(value => (typeof value === 'number' && value >= 1 ? value : undefined), z.number().int().optional()).optional(),
    });

    expect(findBudgetBoundMismatches(bare, zodToMcpInputSchema(bare))).toEqual([
      '$.limit: stated minimum -9007199254740991 is rejected by the parser',
    ]);
  });
});
