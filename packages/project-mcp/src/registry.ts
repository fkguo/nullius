import { z } from 'zod';
import { zodToMcpInputSchema } from '@nullius/shared';
import { coreSpecs, isBackground } from './policy.js';
import { cliSchema } from './cli.js';

export const extraSchemas = {
  project_capabilities: z.object({}).strict(),
  project_file_read: z.object({ path: z.string(), offset: z.number().int().nonnegative().default(0), max_bytes: z.number().int().min(1).max(65536).default(65536) }).strict(),
  project_file_write: z.object({ path: z.string(), content: z.string(), expected_sha256: z.string().regex(/^[a-f0-9]{64}$/).nullable() }).strict(),
  project_delivery_read: z.object({ delivery_id: z.string(), offset: z.number().int().nonnegative().default(0), max_bytes: z.number().int().min(1).max(65536).default(65536) }).strict(),
  project_cli: cliSchema,
};
const descriptions: Record<keyof typeof extraSchemas, string> = {
  project_capabilities: 'Report the bound project, transport capabilities and unavailable host-dependent features. Local code execution is trusted, not OS-sandboxed.',
  project_file_read: 'Read a project document or artifact as a bounded base64 chunk with whole-file SHA-256. Rejects traversal, symlinks and hidden credentials.',
  project_file_write: 'Upload UTF-8 project source/input or checker (up to 1 MiB). expected_sha256=null creates only; replacement requires the current hash. Generated state, receipts and managed projections are protected.',
  project_delivery_read: 'Read a durable transport response. committed means the original response is available, not that research passed. Poll finalizing until the worker releases the project. outcome_unknown must never be automatically rerun; reuse delivery_id to poll.',
  project_cli: 'Invoke a typed canonical Nullius CLI action in this project. Mutations require a stable delivery_id and return a delivery handle. Read stdout/stderr/exit_code; approval requests are not completed calculations.',
};
export function toolsList() {
  return [
    ...Object.entries(extraSchemas).map(([name, schema]) => ({ name, description: descriptions[name as keyof typeof extraSchemas], inputSchema: { ...zodToMcpInputSchema(schema), type: 'object' as const }, annotations: { readOnlyHint: ['project_capabilities', 'project_file_read', 'project_delivery_read'].includes(name) } })),
    ...coreSpecs.map(spec => {
      const schema = zodToMcpInputSchema(spec.zodSchema);
      const properties: Record<string, unknown> = { ...(schema.properties as Record<string, unknown>) };
      if (properties.project_root) properties.project_root = { type: 'string', description: 'Optional: must match the server-bound external project. Omit to use it.' };
      let required = ((schema.required ?? []) as string[]).filter(field => field !== 'project_root');
      if (isBackground(spec.name)) {
        properties.delivery_id = { type: 'string', description: 'Stable unique request ID. Exact replays return the original response; unknown outcomes never run again.' };
        properties.timeout_seconds = { type: 'integer', minimum: 1, maximum: 3600, default: 300 };
        required = [...required, 'delivery_id'];
      }
      return {
        name: spec.name,
        description: spec.description + (isBackground(spec.name) ? ' Project transport: returns a delivery handle; poll project_delivery_read for the original result. Reuse delivery_id after disconnect.' : ''),
        inputSchema: { ...schema, type: 'object' as const, properties, required },
        annotations: { readOnlyHint: spec.execution_policy.mutation_class === 'read_only', destructiveHint: spec.execution_policy.mutation_class === 'stateful' },
      };
    }),
  ];
}
