import { z } from 'zod';
import { PaperSummarySchema } from './paper.js';

// ─────────────────────────────────────────────────────────────────────────────
// Topic Evolution Result
// ─────────────────────────────────────────────────────────────────────────────

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

// ─────────────────────────────────────────────────────────────────────────────
// Batch Import Result
// ─────────────────────────────────────────────────────────────────────────────

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
