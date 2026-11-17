import { z } from 'zod';
import { optionalBudgetInt } from '@nullius/shared';
import { InspireRecidSchema } from '../inspireRecid.js';

export const TimeRangeSchema = z
  .object({
    start: z.number().optional(),
    end: z.number().optional(),
  })
  .optional();

export const TopicAnalysisToolSchema = z.object({
  topic: z.string().min(1),
  mode: z.enum(['timeline', 'evolution', 'all']),
  time_range: TimeRangeSchema,
  options: z.object({
    start_year: z.number().int().optional(),
    end_year: z.number().int().optional(),
    granularity: z.enum(['year', '5year', 'decade']).optional(),
  }).strict().optional(),
}).strict();

export const NetworkAnalysisToolSchema = z.object({
  mode: z.enum(['citation', 'collaboration']),
  seed: z.string().min(1),
  limit: optionalBudgetInt({ min: 1 }),
  options: z
    .object({
      depth: optionalBudgetInt({ min: 0 }),
      direction: z.enum(['refs', 'citations', 'both']).optional(),
      limit_per_layer: optionalBudgetInt({ min: 1 }),
      max_api_calls: optionalBudgetInt({ min: 1 }),
      network_mode: z.enum(['topic', 'author']).optional(),
      min_papers: z.number().int().optional(),
      max_authors_per_paper: optionalBudgetInt({ min: 1 }),
      fold_collaboration_author_count_threshold: optionalBudgetInt({ min: 1 }),
      max_seed_authors_for_expansion: optionalBudgetInt({ min: 1 }),
    })
    .optional(),
}).strict();

export const TraceOriginalSourceToolSchema = z.object({
  recid: InspireRecidSchema,
  max_depth: optionalBudgetInt({ min: 1 }),
  max_refs_per_level: optionalBudgetInt({ min: 1 }),
  cross_validate: z.boolean().optional().describe('Filter source candidates to records cited by at least two distinct traced papers; this is a metadata filter, not independent verification or proof of scientific priority.'),
}).strict();
