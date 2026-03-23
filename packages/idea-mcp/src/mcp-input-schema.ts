import { z, toJSONSchema } from 'zod';

export function zodToMcpInputSchema(schema: z.ZodTypeAny): Record<string, unknown> {
  const jsonSchema = toJSONSchema(schema, {
    target: 'draft-07',
    io: 'input',
    reused: 'inline',
    unrepresentable: 'any',
    override(ctx) {
      const def = (ctx.zodSchema as unknown as z.ZodTypeAny & {
        _zod?: { def?: { type?: string; catchall?: unknown } };
      })._zod?.def;
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

  const { $schema, $defs, ['~standard']: _standard, ...rest } = jsonSchema as Record<string, unknown> & {
    $schema?: string;
    $defs?: unknown;
    '~standard'?: unknown;
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
