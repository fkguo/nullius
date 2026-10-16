import { z, toJSONSchema } from 'zod';

/**
 * Convert a Zod object-like tool schema into an MCP `inputSchema`.
 *
 * MCP tools receive named JSON arguments. Keep the emitted schema inline and
 * object-shaped so clients do not need to resolve `$ref` metadata before
 * deciding whether to show a tool.
 *
 * Dialect: the schema is written in JSON Schema 2020-12 and carries no
 * `$schema` keyword. The MCP specification reads a schema without `$schema`
 * as 2020-12, so the keywords emitted and the dialect clients assume agree.
 *
 * Required keys: an object property must be listed in `required` exactly when
 * parsing fails for an input that omits it. The schema describes the input
 * side (`io: 'input'`), so a property behind `.optional()` or `.default()` is
 * not required. Zod also lists some properties whose omission parses
 * (`.catch()`, `z.unknown()`, `z.any()`, a `z.preprocess()` that accepts
 * undefined); a tool schema wraps such a property in `.optional()`. The shared
 * budget helpers (`optionalBudgetInt` / `optionalBudgetNumber`) do this
 * themselves, and their bounds are published from the `__mcpBudget` metadata
 * below, which a `.describe()` or `.meta()` called directly on the helper's
 * result does not keep. `findRequiredKeyMismatches` checks the rule against
 * the parser, and the MCP packages' tool contract tests run it over the tools
 * they expose.
 */
export function zodToMcpInputSchema(schema: z.ZodType<any, any>): Record<string, unknown> {
  const jsonSchema = toJSONSchema(schema, {
    target: 'draft-2020-12',
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
    throw new Error(`Invalid MCP inputSchema: expected top-level type "object", got ${JSON.stringify(type)}`);
  }

  return normalized;
}
