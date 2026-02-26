/**
 * Consolidated analysis types (NEW-R06).
 *
 * Replaces the 7 versioned files:
 *   analysis-params.ts, analysis-params2.ts, analysis-params3.ts,
 *   analysis-results.ts, analysis-results2.ts, analysis-results3.ts, analysis-results4.ts
 *
 * Canonical JSON Schema: meta/schemas/analysis_types_v1.schema.json
 * Zod schemas remain as runtime validators.
 */

import { z } from 'zod';
import { PaperSummarySchema } from './paper.js';

// ─────────────────────────────────────────────────────────────────────────────
// Analysis Enums
// ─────────────────────────────────────────────────────────────────────────────

export const AnalysisTypeSchema = z.enum([
  'overview',
  'timeline',
  'authors',
  'topics',
  'all',
]);
export type AnalysisType = z.infer<typeof AnalysisTypeSchema>;

export const RelatedStrategySchema = z.enum([
  'high_cited_refs',
  'common_refs',
  'citing_overlap',
  'co_citation',
  'all',
]);
export type RelatedStrategy = z.infer<typeof RelatedStrategySchema>;

export const ExpansionDirectionSchema = z.enum([
  'forward',
  'backward',
  'lateral',
  'all',
]);
export type ExpansionDirection = z.infer<typeof ExpansionDirectionSchema>;

export const SurveyGoalSchema = z.enum([
  'comprehensive_review',
  'quick_overview',
  'find_methods',
  'historical_context',
]);
export type SurveyGoal = z.infer<typeof SurveyGoalSchema>;

export const SurveyPrioritizeSchema = z.enum(['citations', 'recency', 'relevance']);
export type SurveyPrioritize = z.infer<typeof SurveyPrioritizeSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Analysis Params
// ─────────────────────────────────────────────────────────────────────────────

export const AnalyzePapersParamsSchema = z.object({
  recids: z.array(z.string()).min(1),
  analysis_type: z.array(AnalysisTypeSchema).optional().default(['all']),
});
export type AnalyzePapersParams = z.infer<typeof AnalyzePapersParamsSchema>;

export const AnalyzeCollectionParamsSchema = z.object({
  collectionKey: z.string().min(1),
  group_id: z.number().int().optional(),
  analysis_type: z.array(AnalysisTypeSchema).optional().default(['all']),
  max_items: z.number().int().min(1).optional().default(100),
});
export type AnalyzeCollectionParams = z.infer<typeof AnalyzeCollectionParamsSchema>;

export const FindConnectionsParamsSchema = z.object({
  recids: z.array(z.string()).min(1),
  include_external: z.boolean().optional().default(false),
  max_external_depth: z.number().int().min(1).optional().default(1),
});
export type FindConnectionsParams = z.infer<typeof FindConnectionsParamsSchema>;

export const FindRelatedParamsSchema = z.object({
  recids: z.array(z.string()).min(1),
  strategy: RelatedStrategySchema,
  limit: z.number().int().min(1).optional().default(20),
  min_relevance: z.number().min(0).max(1).optional().default(0.3),
});
export type FindRelatedParams = z.infer<typeof FindRelatedParamsSchema>;

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

export const GenerateSurveyParamsSchema = z.object({
  seed_recids: z.array(z.string()).min(1),
  goal: SurveyGoalSchema,
  max_papers: z.number().int().min(5).optional(),
  prioritize: SurveyPrioritizeSchema.optional().default('relevance'),
  include_reviews: z.boolean().optional().default(true),
});
export type GenerateSurveyParams = z.infer<typeof GenerateSurveyParamsSchema>;

export const TopicEvolutionParamsSchema = z.object({
  topic: z.string().min(1),
  start_year: z.number().int().min(1900).optional(),
  end_year: z.number().int().optional(),
  granularity: z.enum(['year', '5year', 'decade']).optional().default('year'),
  include_subtopics: z.boolean().optional().default(false),
});
export type TopicEvolutionParams = z.infer<typeof TopicEvolutionParamsSchema>;

export const BatchImportParamsSchema = z.object({
  recids: z.array(z.string()).min(1),
  target_collection: z.string().optional(),
  group_id: z.number().int().optional(),
  auto_create_collection: z.string().optional(),
  download_pdf: z.boolean().optional().default(true),
  add_tag: z.string().optional(),
});
export type BatchImportParams = z.infer<typeof BatchImportParamsSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Analysis Results
// ─────────────────────────────────────────────────────────────────────────────

export const CollectionAnalysisSchema = z.object({
  item_count: z.number(),
  date_range: z.object({
    earliest: z.string(),
    latest: z.string(),
  }),
  overview: z
    .object({
      total_citations: z.number(),
      avg_citations: z.number(),
      top_cited: z.array(PaperSummarySchema),
      collaborations: z.array(
        z.object({
          name: z.string(),
          count: z.number(),
        })
      ),
      arxiv_categories: z.array(
        z.object({
          category: z.string(),
          count: z.number(),
        })
      ),
    })
    .optional(),
  timeline: z
    .array(
      z.object({
        year: z.number(),
        count: z.number(),
        key_papers: z.array(z.string()),
      })
    )
    .optional(),
  authors: z
    .array(
      z.object({
        name: z.string(),
        paper_count: z.number(),
        total_citations: z.number(),
        bai: z.string().optional(),
      })
    )
    .optional(),
  topics: z
    .array(
      z.object({
        keywords: z.array(z.string()),
        paper_count: z.number(),
        representative_papers: z.array(z.string()),
      })
    )
    .optional(),
});
export type CollectionAnalysis = z.infer<typeof CollectionAnalysisSchema>;

export const ConnectionsResultSchema = z.object({
  internal_edges: z.array(
    z.object({
      source: z.string(),
      target: z.string(),
    })
  ),
  bridge_papers: z.array(
    z.object({
      recid: z.string(),
      title: z.string(),
      connections: z.number(),
    })
  ),
  isolated_papers: z.array(z.string()),
  external_hubs: z.array(PaperSummarySchema).optional(),
});
export type ConnectionsResult = z.infer<typeof ConnectionsResultSchema>;

export const RelatedPapersSchema = z.object({
  papers: z.array(
    z.object({
      recid: z.string(),
      title: z.string(),
      authors: z.array(z.string()),
      year: z.number().optional(),
      citation_count: z.number().optional(),
      relevance_score: z.number(),
      relevance_reason: z.string(),
      connection_count: z.number(),
    })
  ),
  total_candidates: z.number(),
});
export type RelatedPapers = z.infer<typeof RelatedPapersSchema>;

export const ExpansionResultSchema = z.object({
  direction: z.string(),
  papers: z.array(
    z.object({
      recid: z.string(),
      title: z.string(),
      authors: z.array(z.string()),
      year: z.number().optional(),
      citation_count: z.number().optional(),
      connection_strength: z.number(),
      connection_path: z.array(z.string()),
      already_in_library: z.boolean(),
    })
  ),
  emerging_topics: z.array(PaperSummarySchema).optional(),
});
export type ExpansionResult = z.infer<typeof ExpansionResultSchema>;

export const SurveyResultSchema = z.object({
  goal: z.string(),
  sections: z.array(
    z.object({
      name: z.string(),
      description: z.string(),
      papers: z.array(
        z.object({
          recid: z.string(),
          title: z.string(),
          authors: z.array(z.string()),
          year: z.number().optional(),
          citation_count: z.number().optional(),
          why_include: z.string(),
          priority: z.enum(['essential', 'recommended', 'optional']),
          is_review: z.boolean(),
        })
      ),
    })
  ),
  suggested_reading_order: z.array(z.string()),
});
export type SurveyResult = z.infer<typeof SurveyResultSchema>;

export const TopicEvolutionSchema = z.object({
  topic: z.string(),
  time_range: z.object({
    start: z.number(),
    end: z.number(),
  }),
  phases: z.array(
    z.object({
      period: z.string(),
      paper_count: z.number(),
      citation_momentum: z.number(),
      key_papers: z.array(PaperSummarySchema),
      key_authors: z.array(z.string()),
      description: z.string().optional(),
    })
  ),
  subtopics: z
    .array(
      z.object({
        name: z.string(),
        emerged_year: z.number(),
        paper_count: z.number(),
        key_papers: z.array(z.string()),
      })
    )
    .optional(),
  current_status: z.object({
    recent_papers: z.number(),
    growth_rate: z.number(),
    trend: z.enum(['growing', 'stable', 'declining']),
  }),
});
export type TopicEvolution = z.infer<typeof TopicEvolutionSchema>;

export const BatchImportResultSchema = z.object({
  total: z.number(),
  imported: z.number(),
  skipped: z.number(),
  failed: z.number(),
  details: z.array(
    z.object({
      recid: z.string(),
      status: z.enum(['imported', 'skipped', 'failed']),
      zotero_key: z.string().optional(),
      error: z.string().optional(),
    })
  ),
  collection_key: z.string().optional(),
});
export type BatchImportResult = z.infer<typeof BatchImportResultSchema>;
