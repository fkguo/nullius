import { z } from 'zod';
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
            max_refs_to_check: z.number().int().min(1).optional(),
            max_refs_for_nj_query: z.number().int().min(1).optional(),
            max_refs_for_nk_estimate: z.number().int().min(1).optional(),
            nk_search_limit_fast: z.number().int().min(1).max(1000).optional(),
            nk_search_limit_full: z.number().int().min(1).max(1000).optional(),
          })
          .optional(),
        new_entrant: z
          .object({
            lookback_years: z.number().int().min(1).optional(),
            fast_mode_sample_size: z.number().int().min(1).optional(),
          })
          .optional(),
      })
      .optional(),
  })
  .optional();

const NetworkAnalysisOptionsSchema = z
  .object({
    depth: z.number().int().optional(),
    direction: z.enum(['refs', 'citations', 'both']).optional(),
    limit_per_layer: z.number().int().optional(),
    max_api_calls: z.number().int().optional(),
    network_mode: z.enum(['topic', 'author']).optional(),
    min_papers: z.number().int().optional(),
    max_authors_per_paper: z.number().int().min(1).optional(),
    fold_collaboration_author_count_threshold: z.number().int().min(1).optional(),
    max_seed_authors_for_expansion: z.number().int().min(1).optional(),
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
    limit: z.number().int().optional(),

    seed_recid: z.string().min(1).optional(),
    iterations: z.number().int().optional(),
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
    max_external_depth: z.number().int().min(1).optional(),

    max_depth: z.number().int().min(1).optional(),
    max_refs_per_level: z.number().int().min(1).optional(),
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
