import { z } from 'zod';
import { DiscoveryCapabilityNameSchema, DiscoveryProviderIdSchema } from './capabilities.js';
import { DiscoveryQueryIntentSchema } from './query-intent.js';

export const DiscoveryPlanStepSchema = z.object({
  provider: DiscoveryProviderIdSchema,
  reason: z.string().min(1),
});

export const DiscoveryProviderDecisionSchema = z.object({
  provider: DiscoveryProviderIdSchema,
  display_name: z.string().min(1),
  selected: z.boolean(),
  order: z.number().int().positive().optional(),
  reason_codes: z.array(z.string()).default([]),
});

export const DiscoveryQueryPlanSchema = z.object({
  version: z.literal(1),
  query: z.string().min(1),
  normalized_query: z.string().min(1),
  intent: DiscoveryQueryIntentSchema,
  preferred_providers: z.array(DiscoveryProviderIdSchema).default([]),
  required_capabilities: z.array(DiscoveryCapabilityNameSchema).default([]),
  selected_providers: z.array(DiscoveryProviderIdSchema),
  steps: z.array(DiscoveryPlanStepSchema),
  provider_decisions: z.array(DiscoveryProviderDecisionSchema),
});

export type DiscoveryPlanStep = z.infer<typeof DiscoveryPlanStepSchema>;
export type DiscoveryProviderDecision = z.infer<typeof DiscoveryProviderDecisionSchema>;
export type DiscoveryPlan = z.infer<typeof DiscoveryQueryPlanSchema>;
