import { z } from 'zod';

export const SamplingBackendNameSchema = z.enum(['anthropic']);

export const SamplingRouteDefinitionSchema = z.object({
  backend: SamplingBackendNameSchema,
  model: z.string().min(1),
  max_tokens: z.number().int().positive().optional(),
  fallbacks: z.array(z.string().min(1)).optional().default([]),
});

const RiskLevelRouteSelectorsSchema = z.object({
  read: z.string().min(1).optional(),
  write: z.string().min(1).optional(),
  destructive: z.string().min(1).optional(),
}).optional().default({});

const CostClassRouteSelectorsSchema = z.object({
  low: z.string().min(1).optional(),
  medium: z.string().min(1).optional(),
  high: z.string().min(1).optional(),
}).optional().default({});

export const SamplingRoutingSelectorsSchema = z.object({
  tools: z.record(z.string(), z.string().min(1)).optional().default({}),
  modules: z.record(z.string(), z.string().min(1)).optional().default({}),
  module_prompt_versions: z.record(z.string(), z.string().min(1)).optional().default({}),
  risk_levels: RiskLevelRouteSelectorsSchema,
  cost_classes: CostClassRouteSelectorsSchema,
}).optional().default({
  tools: {},
  modules: {},
  module_prompt_versions: {},
  risk_levels: {},
  cost_classes: {},
});

export const SamplingRoutingConfigSchema = z.object({
  version: z.literal(1),
  default_route: z.string().min(1),
  routes: z.record(z.string(), SamplingRouteDefinitionSchema),
  selectors: SamplingRoutingSelectorsSchema,
});
