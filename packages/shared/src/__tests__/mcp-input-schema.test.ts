import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { zodToMcpInputSchema } from '../mcp-input-schema.js';
import { optionalBudgetInt } from '../utils/zodBudget.js';

describe('zodToMcpInputSchema', () => {
  it('normalizes MCP tool inputs to object schemas without resolver-only metadata', () => {
    const schema = z.object({
      q: z.string().min(1),
      limit: optionalBudgetInt({ min: 1, max: 25 }),
      mode: z.enum(['short', 'full']).default('short'),
    });

    expect(zodToMcpInputSchema(schema)).toMatchObject({
      type: 'object',
      additionalProperties: false,
      required: ['q', 'limit'],
      properties: {
        q: { type: 'string', minLength: 1 },
        limit: { type: 'integer', minimum: 1, maximum: 25 },
        mode: { default: 'short' },
      },
    });
    expect(zodToMcpInputSchema(schema)).not.toHaveProperty('$schema');
    expect(zodToMcpInputSchema(schema)).not.toHaveProperty('$defs');
  });

  it('keeps top-level inputSchema object-shaped for optional unions', () => {
    const schema = z.union([
      z.object({ kind: z.literal('a'), a: z.string() }),
      z.object({ kind: z.literal('b'), b: z.string() }),
    ]).optional();

    expect(zodToMcpInputSchema(schema)).toMatchObject({ type: 'object' });
  });

  it('rejects non-object top-level schemas', () => {
    expect(() => zodToMcpInputSchema(z.string())).toThrow(
      'Invalid MCP inputSchema: expected top-level type "object"',
    );
  });
});
