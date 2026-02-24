import { toJSONSchema, z } from 'zod';

/**
 * Convert Zod schema into a portable JSON Schema object.
 *
 * - Uses Zod 4 native `toJSONSchema` (no third-party dependency).
 * - Strips `$schema/$defs` to keep payload small and avoid `$ref` resolution.
 * - Does NOT force top-level `type === "object"` (unlike MCP tool inputs).
 */
export function zodToPortableJsonSchema(schema: z.ZodTypeAny): Record<string, unknown> {
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

  return rest as Record<string, unknown>;
}

