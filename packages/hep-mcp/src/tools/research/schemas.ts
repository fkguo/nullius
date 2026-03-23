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

export const DiscoverPapersOptionsSchema = z
  .object({
    time_range: TimeRangeSchema.optional(),
    include_reviews: z.boolean().optional(),
    include_emerging: z.boolean().optional(),
    min_citations: z.number().int().optional(),

    strategy: z.enum(['high_cited_refs', 'common_refs', 'citing_overlap', 'co_citation', 'all']).optional(),
    min_relevance: z.number().min(0).max(1).optional(),

    direction: z.enum(['forward', 'backward', 'lateral', 'all']).optional(),
    depth: optionalBudgetInt({ min: 0 }),
    filters: z
      .object({
        min_citations: z.number().int().optional(),
        year_range: z
          .object({
            start: z.number().int().optional(),
            end: z.number().int().optional(),
          })
          .optional(),
      })
      .optional(),

    goal: z.enum(['comprehensive_review', 'quick_overview', 'find_methods', 'historical_context']).optional(),
    prioritize: z.enum(['citations', 'recency', 'relevance']).optional(),
  })
  .optional();

export const DiscoverPapersToolSchema = z
  .object({
    mode: z.enum(['seminal', 'related', 'expansion', 'survey']),
    topic: z.string().min(1).optional(),
    seed_recids: z.array(z.string().min(1)).min(1).optional(),
    limit: optionalBudgetInt({ min: 1 }),
    options: DiscoverPapersOptionsSchema,
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.mode === 'seminal') {
      if (!v.topic) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "mode='seminal' requires topic",
          path: ['topic'],
        });
      }
      return;
    }

    if (!v.seed_recids || v.seed_recids.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `mode='${v.mode}' requires seed_recids`,
        path: ['seed_recids'],
      });
    }
  });

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

export const FieldSurveyToolSchema = z.object({
  topic: z.string().min(1),
  seed_recid: z.string().optional(),
  iterations: optionalBudgetInt({ min: 0 }),
  max_papers: optionalBudgetInt({ min: 1 }),
  focus: z
    .array(z.enum(['controversies', 'open_questions', 'methodology', 'recent_progress']))
    .optional(),
  prefer_journal: z.boolean().optional(),
}).strict();

export const TraceOriginalSourceToolSchema = z.object({
  recid: z.string().min(1),
  max_depth: optionalBudgetInt({ min: 1 }),
  max_refs_per_level: optionalBudgetInt({ min: 1 }),
  cross_validate: z.boolean().optional(),
}).strict();
