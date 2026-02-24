import { z } from 'zod';
import { SurveyGoalSchema } from './analysis-params.js';

// ─────────────────────────────────────────────────────────────────────────────
// Generate Survey Params
// ─────────────────────────────────────────────────────────────────────────────

export const SurveyPrioritizeSchema = z.enum(['citations', 'recency', 'relevance']);
export type SurveyPrioritize = z.infer<typeof SurveyPrioritizeSchema>;

export const GenerateSurveyParamsSchema = z.object({
  seed_recids: z.array(z.string()).min(1),
  goal: SurveyGoalSchema,
  max_papers: z.number().int().min(5).optional(),
  prioritize: SurveyPrioritizeSchema.optional().default('relevance'),
  include_reviews: z.boolean().optional().default(true),
});

export type GenerateSurveyParams = z.infer<typeof GenerateSurveyParamsSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Topic Evolution Params
// ─────────────────────────────────────────────────────────────────────────────

export const TopicEvolutionParamsSchema = z.object({
  topic: z.string().min(1),
  start_year: z.number().int().min(1900).optional(),
  end_year: z.number().int().optional(),
  granularity: z.enum(['year', '5year', 'decade']).optional().default('year'),
  include_subtopics: z.boolean().optional().default(false),
});

export type TopicEvolutionParams = z.infer<typeof TopicEvolutionParamsSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Batch Import Params
// ─────────────────────────────────────────────────────────────────────────────

export const BatchImportParamsSchema = z.object({
  recids: z.array(z.string()).min(1),
  target_collection: z.string().optional(),
  group_id: z.number().optional(),
  auto_create_collection: z.string().optional(),
  download_pdf: z.boolean().optional().default(true),
  add_tag: z.string().optional(),
});

export type BatchImportParams = z.infer<typeof BatchImportParamsSchema>;
