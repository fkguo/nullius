import { z } from 'zod';

export const ChatBackendNameSchema = z.enum(['anthropic']);

export const ChatRouteDefinitionSchema = z.object({
  backend: ChatBackendNameSchema,
  model: z.string().min(1),
  max_tokens: z.number().int().positive().optional(),
});

export const ChatRoutingConfigSchema = z.object({
  version: z.literal(1),
  default_route: z.string().min(1),
  routes: z.record(z.string(), ChatRouteDefinitionSchema),
  use_cases: z.record(z.string(), z.string()).optional().default({}),
});
