import { z, toJSONSchema } from 'zod';

/**
 * Convert a Zod schema into an MCP `inputSchema`.
 *
 * MCP tools use a JSON-Schema-like object; we strip `$schema/definitions` to keep
 * the payload small and avoid `$ref` resolution requirements in clients.
 *
 * Uses Zod 4's native toJSONSchema instead of the third-party zod-to-json-schema library.
 */
export function zodToMcpInputSchema(schema: z.ZodType<any, any>): Record<string, unknown> {
  const jsonSchema = toJSONSchema(schema, {
    target: 'draft-07',
    reused: 'inline', // Equivalent to $refStrategy: 'none' - don't use $ref
    unrepresentable: 'any', // Transform types become {} instead of throwing
  });

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { $schema, $defs, ['~standard']: _standard, ...rest } = jsonSchema as unknown as {
    $schema?: string;
    $defs?: unknown;
    '~standard'?: unknown;
    [key: string]: unknown;
  };

  const normalized = { ...rest } as Record<string, unknown>;

  // MCP tool inputs are always JSON objects (named arguments).
  // Some Zod constructs may produce a schema without a top-level `type`.
  // Clients like Cursor validate `inputSchema.type === "object"` and will hide
  // tools if this is missing.
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
