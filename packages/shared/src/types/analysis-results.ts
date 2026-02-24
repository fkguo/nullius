import { z } from 'zod';
import { PaperSummarySchema } from './paper.js';

// ─────────────────────────────────────────────────────────────────────────────
// Collection Analysis Result
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
