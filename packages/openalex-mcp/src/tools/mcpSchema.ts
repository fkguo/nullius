import { z, toJSONSchema } from 'zod';

/**
 * Convert a Zod schema into an MCP `inputSchema`.
 *
 * Uses Zod 4's native toJSONSchema instead of the third-party zod-to-json-schema library.
 */
export function zodToMcpInputSchema(schema: z.ZodType<any, any>): Record<string, unknown> {
  const jsonSchema = toJSONSchema(schema, {
    target: 'draft-07',
    io: 'input',
    reused: 'inline',
    unrepresentable: 'any',
    override(ctx) {
      const def = (ctx.zodSchema as unknown as z.ZodType<any, any> & {
        _zod?: { def?: { type?: string; catchall?: unknown } };
      })._zod?.def;
      const budgetMeta = (ctx.zodSchema as unknown as z.ZodType<any, any> & {
        __mcpBudget?: { min?: number; max?: number; integer: boolean };
      }).__mcpBudget;
      if (budgetMeta) {
        (ctx.jsonSchema as Record<string, unknown>).type = budgetMeta.integer ? 'integer' : 'number';
        if (budgetMeta.min !== undefined) {
          (ctx.jsonSchema as Record<string, unknown>).minimum = budgetMeta.min;
        }
        if (budgetMeta.max !== undefined) {
          (ctx.jsonSchema as Record<string, unknown>).maximum = budgetMeta.max;
        }
      }
      if (def?.type === 'default') {
        (ctx.jsonSchema as Record<string, unknown>).default = JSON.parse(
          JSON.stringify((def as unknown as { defaultValue: unknown }).defaultValue),
        );
      }
      if (def?.type === 'object' && !def.catchall) {
        (ctx.jsonSchema as Record<string, unknown>).additionalProperties = false;
      }
    },
  });

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { $schema, $defs, ['~standard']: _standard, ...rest } = jsonSchema as unknown as {
    $schema?: string;
    $defs?: unknown;
    '~standard'?: unknown;
    [key: string]: unknown;
  };

  const normalized = { ...rest } as Record<string, unknown>;

  const type = normalized.type;
  if (type === undefined) {
    normalized.type = 'object';
    return normalized;
  }
  if (type !== 'object') {
    throw new Error(
      `Invalid MCP inputSchema: expected top-level type "object", got ${JSON.stringify(type)}`,
    );
  }

  return normalized;
}
