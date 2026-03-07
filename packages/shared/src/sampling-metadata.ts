import { z } from 'zod';

export const SamplingCostClassSchema = z.enum(['low', 'medium', 'high']);
export type SamplingCostClass = z.infer<typeof SamplingCostClassSchema>;

const ToolRiskLevelSchema = z.enum(['read', 'write', 'destructive']);
const SamplingContextValueSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);
const SamplingContextSchema = z.record(z.string(), SamplingContextValueSchema);
const FORBIDDEN_CONTEXT_KEYS = new Set(['backend', 'model', 'route', 'route_key']);

export const SamplingMetadataSchema = z.object({
  module: z.string().min(1),
  tool: z.string().min(1),
  prompt_version: z.string().min(1),
  risk_level: ToolRiskLevelSchema,
  cost_class: SamplingCostClassSchema,
  context: SamplingContextSchema.optional(),
}).strict();

export type SamplingMetadata = z.infer<typeof SamplingMetadataSchema>;
export type SamplingMetadataContext = z.infer<typeof SamplingContextSchema>;

function assertNoRoutingHints(context: SamplingMetadataContext | undefined): void {
  if (!context) return;
  const forbidden = Object.keys(context).filter(key => FORBIDDEN_CONTEXT_KEYS.has(key));
  if (forbidden.length > 0) {
    throw new Error(`Sampling metadata context cannot contain routing hints: ${forbidden.join(', ')}`);
  }
}

export function parseSamplingMetadata(input: unknown): SamplingMetadata {
  const parsed = SamplingMetadataSchema.parse(input);
  assertNoRoutingHints(parsed.context);
  return parsed;
}

export function buildSamplingMetadata(input: SamplingMetadata): SamplingMetadata {
  return parseSamplingMetadata(input);
}
