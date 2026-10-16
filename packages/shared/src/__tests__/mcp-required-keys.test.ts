import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { zodToMcpInputSchema } from '../mcp-input-schema.js';
import { findRequiredKeyMismatches } from '../mcp-required-keys.js';
import { optionalBudgetInt, optionalBudgetNumber } from '../utils/zodBudget.js';

// Keys of `valid` whose omission (all other keys kept) makes the schema reject the input.
function keysWhoseOmissionFails(schema: z.ZodType, valid: Record<string, unknown>): string[] {
  expect(schema.safeParse(valid).success).toBe(true);
  return Object.keys(valid).filter(key => {
    const { [key]: _omitted, ...rest } = valid;
    return !schema.safeParse(rest).success;
  });
}

function requiredOf(json: unknown): string[] {
  const required = (json as { required?: unknown }).required;
  return Array.isArray(required) ? (required as string[]) : [];
}

const nested = z.object({
  depth: optionalBudgetInt({ min: 1, max: 5 }),
  label: z.string(),
});

const representative = z.object({
  query: z.string().min(1),
  budget_bare: optionalBudgetInt({ min: 1, max: 50 }),
  budget_number_bare: optionalBudgetNumber({ min: 0.5 }),
  budget_default: optionalBudgetInt({ min: 1 }).default(10),
  budget_optional: optionalBudgetInt({ min: 0 }).optional(),
  budget_described: optionalBudgetInt({ min: 1 }).describe('a described budget field'),
  plain_optional: z.number().int().optional(),
  plain_default: z.enum(['a', 'b']).default('a'),
  nullable_required: z.string().nullable(),
  options: nested,
  options_optional: nested.optional(),
});

const validInput = {
  query: 'q',
  budget_bare: 3,
  budget_number_bare: 1.5,
  budget_default: 4,
  budget_optional: 2,
  budget_described: 7,
  plain_optional: 1,
  plain_default: 'b',
  nullable_required: null,
  options: { depth: 2, label: 'x' },
  options_optional: { depth: 2, label: 'y' },
};

describe('MCP inputSchema required keys', () => {
  it('lists exactly the top-level keys whose omission fails to parse', () => {
    const json = zodToMcpInputSchema(representative);
    const expected = keysWhoseOmissionFails(representative, validInput);

    expect(expected.sort()).toEqual(['nullable_required', 'options', 'query']);
    expect([...requiredOf(json)].sort()).toEqual(expected);
  });

  it('lists exactly the nested keys whose omission fails to parse', () => {
    const json = zodToMcpInputSchema(representative) as {
      properties: Record<string, unknown>;
    };
    const expectedNested = keysWhoseOmissionFails(nested, validInput.options);

    expect(expectedNested).toEqual(['label']);
    expect(requiredOf(json.properties.options)).toEqual(expectedNested);
    expect(requiredOf(json.properties.options_optional)).toEqual(expectedNested);
  });

  it('keeps the budget bounds in the published schema', () => {
    const json = zodToMcpInputSchema(representative) as {
      properties: Record<string, Record<string, unknown>>;
    };

    expect(json.properties.budget_bare).toMatchObject({ type: 'integer', minimum: 1, maximum: 50 });
    expect(json.properties.budget_number_bare).toMatchObject({ type: 'number', minimum: 0.5 });
    expect(json.properties.budget_default).toMatchObject({ type: 'integer', minimum: 1, default: 10 });
    expect(json.properties.budget_optional).toMatchObject({ type: 'integer', minimum: 0 });
  });

  it('finds no mismatch in what the converter emits for the representative schema', () => {
    expect(findRequiredKeyMismatches(representative, zodToMcpInputSchema(representative))).toEqual([]);
  });

  it('reports a key listed in required although its omission parses, at any depth', () => {
    const json = structuredClone(zodToMcpInputSchema(representative)) as {
      required: string[];
      properties: Record<string, { required?: string[] }>;
    };
    json.required.push('budget_bare');
    json.properties.options.required = ['label', 'depth'];

    expect(findRequiredKeyMismatches(representative, json)).toEqual([
      '$: listed in required but omission parses: budget_bare',
      '$.options: listed in required but omission parses: depth',
    ]);
  });

  it('reports a key missing from required although its omission fails', () => {
    const json = structuredClone(zodToMcpInputSchema(representative)) as {
      required: string[];
      properties: Record<string, { required?: string[] }>;
    };
    json.required = json.required.filter(key => key !== 'query');
    delete json.properties.options_optional.required;

    expect(findRequiredKeyMismatches(representative, json)).toEqual([
      '$: omission fails to parse but not listed in required: query',
      '$.options_optional: omission fails to parse but not listed in required: label',
    ]);
  });

  it('follows arrays, records, unions and nullable objects', () => {
    const item = z.object({ id: z.string(), limit: optionalBudgetInt({ min: 1 }) });
    const schema = z.object({
      list: z.array(item),
      map: z.record(z.string(), item),
      either: z.union([item, z.object({ other: z.number() })]),
      maybe: item.nullable(),
    });
    const json = zodToMcpInputSchema(schema);

    expect(findRequiredKeyMismatches(schema, json)).toEqual([]);

    const tampered = structuredClone(json) as Record<string, any>;
    tampered.properties.list.items.required.push('limit');
    tampered.properties.map.additionalProperties.required.push('limit');
    tampered.properties.either.anyOf[0].required.push('limit');
    tampered.properties.maybe.anyOf[0].required.push('limit');

    expect(findRequiredKeyMismatches(schema, tampered)).toEqual([
      '$.list[]: listed in required but omission parses: limit',
      '$.map{}: listed in required but omission parses: limit',
      '$.either|0: listed in required but omission parses: limit',
      '$.maybe|0: listed in required but omission parses: limit',
    ]);
  });

  it('follows tuples, enumerated-key records and chained intersections', () => {
    const item = z.object({ id: z.string(), limit: optionalBudgetInt({ min: 1 }) });
    const schema = z.object({
      pair: z.tuple([item, z.string()]),
      by_kind: z.record(z.enum(['a', 'b']), item),
      merged: z.object({ x: z.string() }).and(z.object({ y: optionalBudgetInt() })).and(item),
    });
    const json = zodToMcpInputSchema(schema);

    expect(findRequiredKeyMismatches(schema, json)).toEqual([]);

    const tampered = structuredClone(json) as Record<string, any>;
    tampered.properties.pair.prefixItems[0].required.push('limit');
    tampered.properties.by_kind.required = ['a'];
    tampered.properties.by_kind.additionalProperties.required.push('limit');
    tampered.properties.merged.allOf[1].required = ['y'];
    tampered.properties.merged.allOf[2].required.push('limit');

    expect(findRequiredKeyMismatches(schema, tampered)).toEqual([
      '$.pair[0]: listed in required but omission parses: limit',
      '$.by_kind: omission fails to parse but not listed in required: b',
      '$.by_kind{}: listed in required but omission parses: limit',
      '$.merged&1: listed in required but omission parses: y',
      '$.merged&2: listed in required but omission parses: limit',
    ]);
  });

  it('reports JSON structure it cannot match to the Zod schema', () => {
    const schema = z.object({ options: nested });

    expect(findRequiredKeyMismatches(schema, { type: 'object', required: ['options'], properties: { options: { type: 'string' } } })).toEqual([
      '$.options: Zod object has no JSON object with properties',
    ]);
  });
});
