import { z } from 'zod';
import {
  RelatedStrategySchema,
  ExpansionDirectionSchema,
} from './analysis-params.js';

// ─────────────────────────────────────────────────────────────────────────────
// Find Connections Params
// ─────────────────────────────────────────────────────────────────────────────

export const FindConnectionsParamsSchema = z.object({
  recids: z.array(z.string()).min(1),
  include_external: z.boolean().optional().default(false),
  max_external_depth: z.number().int().min(1).optional().default(1),
});

export type FindConnectionsParams = z.infer<typeof FindConnectionsParamsSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Find Related Papers Params
// ─────────────────────────────────────────────────────────────────────────────

export const FindRelatedParamsSchema = z.object({
  recids: z.array(z.string()).min(1),
  strategy: RelatedStrategySchema,
  limit: z.number().int().min(1).optional().default(20),
  min_relevance: z.number().min(0).max(1).optional().default(0.3),
});

export type FindRelatedParams = z.infer<typeof FindRelatedParamsSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Research Expansion Params
// ─────────────────────────────────────────────────────────────────────────────

export const ResearchExpansionParamsSchema = z.object({
  seed_recids: z.array(z.string()).min(1),
  direction: ExpansionDirectionSchema,
  depth: z.number().int().min(1).optional().default(2),
  max_results: z.number().int().min(1).optional().default(30),
  filters: z
    .object({
      min_citations: z.number().int().optional(),
      year_range: z
        .object({
          start: z.number().int().optional(),
          end: z.number().int().optional(),
        })
        .optional(),
      exclude_in_library: z.boolean().optional().default(true),
    })
    .optional(),
});

export type ResearchExpansionParams = z.infer<typeof ResearchExpansionParamsSchema>;
