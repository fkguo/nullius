import { z } from 'zod';
import { PromptExpectedFormatSchema, PromptPacketSchema } from './promptPacket.js';

export const ClientContinuationActionSchema = z.enum([
  'GENERATE_JSON',
  'GENERATE_SECTION',
  'RERANK',
  'REVIEW',
  'REVISE_PLAN',
]);
export type ClientContinuationAction = z.output<typeof ClientContinuationActionSchema>;

const SubmitToolSchema = z
  .object({
    name: z.string().min(1),
    args_template: z.record(z.string(), z.any()),
  })
  .strict();

export const ClientContinuationStepSchema = z
  .object({
    id: z.string().min(1),
    action: ClientContinuationActionSchema,
    prompt_packet_uri: z.string().min(1).optional(),
    prompt_packet: PromptPacketSchema.optional(),
    expected_format: PromptExpectedFormatSchema,
    submit_tool: SubmitToolSchema.optional(),
    verification_tools: z.array(z.string().min(1)).optional().default([]),
    metadata: z.record(z.string(), z.any()).optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    const hasInline = Boolean(v.prompt_packet);
    const hasUri = Boolean(v.prompt_packet_uri);
    if (!hasInline && !hasUri) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Either prompt_packet or prompt_packet_uri is required',
        path: ['prompt_packet'],
      });
    }
    if (hasInline && hasUri) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Use either prompt_packet or prompt_packet_uri (not both)',
        path: ['prompt_packet_uri'],
      });
    }
    if (v.prompt_packet && v.prompt_packet.expected_output_format !== v.expected_format) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'expected_format must match prompt_packet.expected_output_format',
        path: ['expected_format'],
      });
    }
  });

export const ClientContinuationSchema = z
  .object({
    version: z.literal(1).optional().default(1),
    generated_at: z.string().min(1),
    run_id: z.string().min(1).optional(),
    instructions: z.string().min(1),
    steps: z.array(ClientContinuationStepSchema).min(1),
  })
  .strict();

export type ClientContinuationStep = z.output<typeof ClientContinuationStepSchema>;
export type ClientContinuation = z.output<typeof ClientContinuationSchema>;
