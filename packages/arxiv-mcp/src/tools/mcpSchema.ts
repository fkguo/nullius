import { z, toJSONSchema } from 'zod';

/**
 * Convert a Zod schema into an MCP `inputSchema`.
 *
 * Uses Zod 4's native toJSONSchema. Strips `$schema/definitions` to keep
 * the payload small and avoid `$ref` resolution requirements in clients.
 */
export function zodToMcpInputSchema(schema: z.ZodType<any, any>): Record<string, unknown> {
  const jsonSchema = toJSONSchema(schema, {
    target: 'draft-07',
    reused: 'inline',
    unrepresentable: 'any',
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
    throw new Error(`Invalid MCP inputSchema: expected top-level type "object", got ${JSON.stringify(type)}`);
  }

  return normalized;
}
