import { z } from 'zod';
import { optionalBudgetInt } from '@autoresearch/shared';
import {
  DiscoverPapersOptionsSchema,
  TimeRangeSchema,
} from './schemas.js';

const JsonMarkdownSchema = z.enum(['json', 'markdown']);

const FieldSurveyFocusSchema = z.enum([
  'controversies',
  'open_questions',
  'methodology',
  'recent_progress',
]);

const TopicAnalysisOptionsSchema = z
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
  .optional();

const NetworkAnalysisOptionsSchema = z
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
  .optional();

export const ResearchNavigatorToolSchema = z
  .object({
    mode: z.enum([
      'discover',
      'field_survey',
      'topic_analysis',
      'network',
      'experts',
      'connections',
      'trace_source',
      'analyze',
    ]),

    discover_mode: z.enum(['seminal', 'related', 'expansion', 'survey']).optional(),
    discover_options: DiscoverPapersOptionsSchema,
    seed_recids: z.array(z.string().min(1)).min(1).optional(),

    topic: z.string().min(1).optional(),
    limit: optionalBudgetInt({ min: 1 }),

    seed_recid: z.string().min(1).optional(),
    iterations: optionalBudgetInt({ min: 0 }),
    focus: z.array(FieldSurveyFocusSchema).optional(),
    prefer_journal: z.boolean().optional(),
    format: JsonMarkdownSchema.optional(),

    topic_mode: z.enum(['timeline', 'evolution', 'emerging', 'all']).optional(),
    time_range: TimeRangeSchema,
    topic_options: TopicAnalysisOptionsSchema,

    network_mode: z.enum(['citation', 'collaboration']).optional(),
    seed: z.string().min(1).optional(),
    network_options: NetworkAnalysisOptionsSchema,

    include_external: z.boolean().optional(),
    max_external_depth: optionalBudgetInt({ min: 1 }),

    max_depth: optionalBudgetInt({ min: 1 }),
    max_refs_per_level: optionalBudgetInt({ min: 1 }),
    cross_validate: z.boolean().optional(),

    recids: z.array(z.string().min(1)).min(1).optional(),
    analysis_type: z.array(z.enum(['overview', 'timeline', 'authors', 'topics', 'all'])).optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    const has = (key: keyof typeof v): boolean => {
      return Object.prototype.hasOwnProperty.call(v, key);
    };

    const requireField = (condition: boolean, field: keyof typeof v, message: string) => {
      if (!condition) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message,
          path: [field],
        });
      }
    };

    const rejectField = (condition: boolean, field: keyof typeof v, message: string) => {
      if (condition) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message,
          path: [field],
        });
      }
    };

    switch (v.mode) {
      case 'discover': {
        requireField(Boolean(v.discover_mode), 'discover_mode', "mode='discover' requires discover_mode");
        if (v.discover_mode === 'seminal') {
          requireField(Boolean(v.topic), 'topic', "mode='discover' + discover_mode='seminal' requires topic");
        }
        if (v.discover_mode === 'related' || v.discover_mode === 'expansion' || v.discover_mode === 'survey') {
          requireField(Boolean(v.seed_recids?.length), 'seed_recids', `mode='discover' + discover_mode='${v.discover_mode}' requires seed_recids`);
        }
        rejectField(has('topic_mode'), 'topic_mode', "topic_mode is only allowed when mode='topic_analysis'");
        rejectField(has('network_mode'), 'network_mode', "network_mode is only allowed when mode='network'");
        rejectField(has('format'), 'format', "format is only allowed when mode='experts'");
        break;
      }
      case 'field_survey': {
        requireField(Boolean(v.topic), 'topic', "mode='field_survey' requires topic");
        rejectField(has('discover_mode'), 'discover_mode', "discover_mode is only allowed when mode='discover'");
        rejectField(has('topic_mode'), 'topic_mode', "topic_mode is only allowed when mode='topic_analysis'");
        rejectField(has('network_mode'), 'network_mode', "network_mode is only allowed when mode='network'");
        rejectField(has('format'), 'format', "format is only allowed when mode='experts'");
        break;
      }
      case 'topic_analysis': {
        requireField(Boolean(v.topic), 'topic', "mode='topic_analysis' requires topic");
        requireField(Boolean(v.topic_mode), 'topic_mode', "mode='topic_analysis' requires topic_mode");
        rejectField(has('discover_mode'), 'discover_mode', "discover_mode is only allowed when mode='discover'");
        rejectField(has('network_mode'), 'network_mode', "network_mode is only allowed when mode='network'");
        rejectField(has('format'), 'format', "format is only allowed when mode='experts'");
        break;
      }
      case 'network': {
        requireField(Boolean(v.network_mode), 'network_mode', "mode='network' requires network_mode");
        requireField(Boolean(v.seed), 'seed', "mode='network' requires seed");
        rejectField(has('discover_mode'), 'discover_mode', "discover_mode is only allowed when mode='discover'");
        rejectField(has('topic_mode'), 'topic_mode', "topic_mode is only allowed when mode='topic_analysis'");
        rejectField(has('format'), 'format', "format is only allowed when mode='experts'");
        break;
      }
      case 'experts': {
        requireField(Boolean(v.topic), 'topic', "mode='experts' requires topic");
        rejectField(has('discover_mode'), 'discover_mode', "discover_mode is only allowed when mode='discover'");
        rejectField(has('topic_mode'), 'topic_mode', "topic_mode is only allowed when mode='topic_analysis'");
        rejectField(has('network_mode'), 'network_mode', "network_mode is only allowed when mode='network'");
        break;
      }
      case 'connections': {
        requireField(Boolean(v.seed) || Boolean(v.seed_recids?.length), 'seed_recids', "mode='connections' requires seed_recids or seed");
        rejectField(has('discover_mode'), 'discover_mode', "discover_mode is only allowed when mode='discover'");
        rejectField(has('topic_mode'), 'topic_mode', "topic_mode is only allowed when mode='topic_analysis'");
        rejectField(has('network_mode'), 'network_mode', "network_mode is only allowed when mode='network'");
        rejectField(has('format'), 'format', "format is only allowed when mode='experts'");
        break;
      }
      case 'trace_source': {
        requireField(Boolean(v.seed) || Boolean(v.seed_recids?.length), 'seed', "mode='trace_source' requires seed or seed_recids");
        if (v.seed_recids && v.seed_recids.length !== 1) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "mode='trace_source' seed_recids must contain exactly one recid",
            path: ['seed_recids'],
          });
        }
        rejectField(has('discover_mode'), 'discover_mode', "discover_mode is only allowed when mode='discover'");
        rejectField(has('topic_mode'), 'topic_mode', "topic_mode is only allowed when mode='topic_analysis'");
        rejectField(has('network_mode'), 'network_mode', "network_mode is only allowed when mode='network'");
        rejectField(has('format'), 'format', "format is only allowed when mode='experts'");
        break;
      }
      case 'analyze': {
        requireField(
          Boolean(v.recids?.length) || Boolean(v.seed_recids?.length) || Boolean(v.seed),
          'recids',
          "mode='analyze' requires recids or seed_recids or seed"
        );
        rejectField(has('discover_mode'), 'discover_mode', "discover_mode is only allowed when mode='discover'");
        rejectField(has('topic_mode'), 'topic_mode', "topic_mode is only allowed when mode='topic_analysis'");
        rejectField(has('network_mode'), 'network_mode', "network_mode is only allowed when mode='network'");
        rejectField(has('format'), 'format', "format is only allowed when mode='experts'");
        break;
      }
      default:
        break;
    }
  });

export type ResearchNavigatorToolInput = z.output<typeof ResearchNavigatorToolSchema>;
