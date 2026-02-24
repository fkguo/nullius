/**
 * Smoke test: Ensure no MCP tool has top-level oneOf/anyOf/allOf in its JSON Schema.
 *
 * Background: Some API gateways (e.g., custom ANTHROPIC_BASE_URL proxies) reject
 * tool schemas with top-level oneOf/anyOf/allOf. This test prevents regressions.
 *
 * Run: npx tsx tests/smoke-no-toplevel-union.test.ts
 */
import { describe, it, expect } from 'vitest';
import { z, toJSONSchema } from 'zod';
import { TOOL_SPECS } from '../src/tools/registry.js';

function zodToMcpInputSchema(schema: z.ZodType<any, any>): Record<string, unknown> {
  const jsonSchema = toJSONSchema(schema, {
    target: 'draft-07',
    reused: 'inline',
    unrepresentable: 'any',
  });

  const { $schema, $defs, ['~standard']: _standard, ...rest } = jsonSchema as any;
  const normalized = { ...rest } as Record<string, unknown>;

  if (normalized.type === undefined) {
    normalized.type = 'object';
  }

  return normalized;
}

describe('MCP Tool Schema Compatibility', () => {
  it('no tool should have top-level oneOf/anyOf/allOf (gateway compatibility)', () => {
    const problematic: string[] = [];

    for (const tool of TOOL_SPECS) {
      const schema = zodToMcpInputSchema(tool.zodSchema);
      if ('oneOf' in schema || 'anyOf' in schema || 'allOf' in schema) {
        problematic.push(
          `${tool.name}: oneOf=${('oneOf' in schema)}, anyOf=${('anyOf' in schema)}, allOf=${('allOf' in schema)}`
        );
      }
    }

    expect(problematic).toEqual([]);
  });
});
