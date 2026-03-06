import { z } from 'zod';
import { DiscoveryCapabilityNameSchema, DiscoveryProviderIdSchema } from './capabilities.js';

export const DiscoveryQueryIntentSchema = z.enum([
  'known_item',
  'keyword_search',
  'semantic_search',
  'citation_expansion',
  'fulltext_search',
]);

export const DiscoveryPlannerRequestSchema = z.object({
  intent: DiscoveryQueryIntentSchema,
  query: z.string().min(1),
  preferred_providers: z.array(DiscoveryProviderIdSchema).optional().default([]),
  required_capabilities: z.array(DiscoveryCapabilityNameSchema).optional().default([]),
  limit: z.number().int().positive().optional(),
});

export type DiscoveryQueryIntent = z.infer<typeof DiscoveryQueryIntentSchema>;
export type DiscoveryPlannerRequest = z.infer<typeof DiscoveryPlannerRequestSchema>;
