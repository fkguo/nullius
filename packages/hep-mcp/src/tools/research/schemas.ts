import { z } from 'zod';
import { optionalBudgetInt } from '@autoresearch/shared';

export const TimeRangeSchema = z
  .object({
    start: z.number().optional(),
    end: z.number().optional(),
  })
  .optional();

export const TopicAnalysisToolSchema = z.object({
  topic: z.string().min(1),
  mode: z.enum(['timeline', 'evolution', 'emerging', 'all']),
  time_range: TimeRangeSchema,
  limit: optionalBudgetInt({ min: 1 }),
  options: z
    .object({
      start_year: z.number().int().optional(),
      end_year: z.number().int().optional(),
      granularity: z.enum(['year', '5year', 'decade']).optional(),
      include_subtopics: z.boolean().optional(),
      min_citations: z.number().int().optional(),
      min_momentum: z.number().int().optional(),
      include_sociology: z.boolean().optional(),
      sample_mode: z.enum(['full', 'fast']).optional(),
      sociology_options: z
        .object({
          disruption: z
            .object({
              max_refs_to_check: optionalBudgetInt({ min: 1 }),
              max_refs_for_nj_query: optionalBudgetInt({ min: 1 }),
              max_refs_for_nk_estimate: optionalBudgetInt({ min: 1 }),
              nk_search_limit_fast: optionalBudgetInt({ min: 1, max: 1000 }),
              nk_search_limit_full: optionalBudgetInt({ min: 1, max: 1000 }),
            })
            .optional(),
          new_entrant: z
            .object({
              lookback_years: z.number().int().min(1).optional(),
              fast_mode_sample_size: optionalBudgetInt({ min: 1 }),
            })
            .optional(),
        })
        .optional(),
    })
    .optional(),
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
  recid: z.string().min(1),
  max_depth: optionalBudgetInt({ min: 1 }),
  max_refs_per_level: optionalBudgetInt({ min: 1 }),
  cross_validate: z.boolean().optional(),
}).strict();
