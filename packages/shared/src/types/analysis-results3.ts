import { z } from 'zod';
import { PaperSummarySchema } from './paper.js';

// ─────────────────────────────────────────────────────────────────────────────
// Expansion Result
// ─────────────────────────────────────────────────────────────────────────────

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

// ─────────────────────────────────────────────────────────────────────────────
// Survey Result
// ─────────────────────────────────────────────────────────────────────────────

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
