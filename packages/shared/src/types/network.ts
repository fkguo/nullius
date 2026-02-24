import { z } from 'zod';
import { PaperSummarySchema } from './paper.js';

// ─────────────────────────────────────────────────────────────────────────────
// Citation Network Params
// ─────────────────────────────────────────────────────────────────────────────

export const CitationNetworkParamsSchema = z.object({
  recid: z.string().min(1),
  depth: z.number().int().min(1).optional().default(2),
  direction: z.enum(['refs', 'citations', 'both']).optional().default('both'),
  limit_per_layer: z.number().int().min(1).optional().default(20),
  max_api_calls: z.number().int().min(1).optional().default(10),
});

export type CitationNetworkParams = z.infer<typeof CitationNetworkParamsSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Network Node Schema
// ─────────────────────────────────────────────────────────────────────────────

export const NetworkNodeSchema = z.object({
  recid: z.string(),
  title: z.string(),
  authors: z.array(z.string()),
  year: z.number().optional(),
  citation_count: z.number().optional(),
  depth: z.number().int(),
  importance: z.number().optional(),
});

export type NetworkNode = z.infer<typeof NetworkNodeSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Edge Schema
// ─────────────────────────────────────────────────────────────────────────────

export const EdgeSchema = z.object({
  source: z.string(),
  target: z.string(),
  type: z.enum(['cites', 'cited_by']),
});

export type Edge = z.infer<typeof EdgeSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Citation Network Result Schema
// ─────────────────────────────────────────────────────────────────────────────

export const CitationNetworkSchema = z.object({
  center: PaperSummarySchema,
  nodes: z.array(NetworkNodeSchema),
  edges: z.array(EdgeSchema),
  key_papers: z.array(PaperSummarySchema),
  api_calls_used: z.number().int(),
});

export type CitationNetwork = z.infer<typeof CitationNetworkSchema>;
