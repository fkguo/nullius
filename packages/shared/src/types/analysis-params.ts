import { z } from 'zod';

// ─────────────────────────────────────────────────────────────────────────────
// Analysis Type Enums
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

// ─────────────────────────────────────────────────────────────────────────────
// Analysis Params Schemas
// ─────────────────────────────────────────────────────────────────────────────

export const AnalyzePapersParamsSchema = z.object({
  recids: z.array(z.string()).min(1),
  analysis_type: z.array(AnalysisTypeSchema).optional().default(['all']),
});

export type AnalyzePapersParams = z.infer<typeof AnalyzePapersParamsSchema>;

export const AnalyzeCollectionParamsSchema = z.object({
  collectionKey: z.string().min(1),
  group_id: z.number().optional(),
  analysis_type: z.array(AnalysisTypeSchema).optional().default(['all']),
  max_items: z.number().int().min(1).optional().default(100),
});

export type AnalyzeCollectionParams = z.infer<typeof AnalyzeCollectionParamsSchema>;
