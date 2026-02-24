import { z } from 'zod';
import { PaperSummarySchema } from './paper.js';

// ─────────────────────────────────────────────────────────────────────────────
// Connections Result
// ─────────────────────────────────────────────────────────────────────────────

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

// ─────────────────────────────────────────────────────────────────────────────
// Related Papers Result
// ─────────────────────────────────────────────────────────────────────────────

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
