import { z } from 'zod';
import { zodToPortableJsonSchema } from './jsonSchema.js';

export const PromptExpectedFormatSchema = z.enum(['json', 'json_array', 'markdown', 'latex']);
export type PromptExpectedFormat = z.output<typeof PromptExpectedFormatSchema>;

export const PromptPacketSchema = z
  .object({
    version: z.literal(1).optional().default(1),
    schema_name: z.string().min(1),
    schema_version: z.number().int().positive(),
    expected_output_format: PromptExpectedFormatSchema,
    output_schema: z.record(z.string(), z.any()).optional(),
    system_prompt: z.string().min(1),
    user_prompt: z.string().min(1),
    context_uris: z.array(z.string().min(1)).optional().default([]),
  })
  .strict()
  .superRefine((v, ctx) => {
    const needsSchema = v.expected_output_format === 'json' || v.expected_output_format === 'json_array';
    if (needsSchema && !v.output_schema) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `output_schema is required when expected_output_format=${v.expected_output_format}`,
        path: ['output_schema'],
      });
    }
  });

export type PromptPacket = z.output<typeof PromptPacketSchema>;

export function makePromptPacketFromZod(params: {
  schema_name: string;
  schema_version: number;
  expected_output_format: PromptExpectedFormat;
  system_prompt: string;
  user_prompt: string;
  output_zod_schema?: z.ZodTypeAny;
  context_uris?: string[];
}): PromptPacket {
  const needsSchema = params.expected_output_format === 'json' || params.expected_output_format === 'json_array';
  if (needsSchema && !params.output_zod_schema) {
    throw new Error(`output_zod_schema is required for expected_output_format=${params.expected_output_format}`);
  }

  const output_schema = params.output_zod_schema ? zodToPortableJsonSchema(params.output_zod_schema) : undefined;

  return PromptPacketSchema.parse({
    version: 1,
    schema_name: params.schema_name,
    schema_version: params.schema_version,
    expected_output_format: params.expected_output_format,
    output_schema,
    system_prompt: params.system_prompt,
    user_prompt: params.user_prompt,
    context_uris: params.context_uris ?? [],
  });
}
