import { z } from 'zod';
import { DiscoveryProviderIdSchema } from './capabilities.js';
import { CanonicalPaperMergeStateSchema } from './canonical-paper.js';

export const DiscoveryRerankStatusSchema = z.enum([
  'applied',
  'unavailable',
  'insufficient_candidates',
]);

export const DiscoveryRerankMethodSchema = z.enum([
  'hybrid_feature_prerank',
  'llm_listwise_rerank',
]);

export const DiscoveryRerankedPaperSchema = z.object({
  canonical_key: z.string().min(1),
  score: z.number().min(0).max(1),
  stage1_score: z.number().min(0).max(1).optional(),
  reason_codes: z.array(z.string()).default([]),
  provider_sources: z.array(DiscoveryProviderIdSchema).default([]),
  merge_state: CanonicalPaperMergeStateSchema,
});

export const DiscoveryRerankArtifactSchema = z.object({
  version: z.literal(1),
  query: z.string().min(1),
  status: DiscoveryRerankStatusSchema,
  reranker: z.object({
    name: z.string().min(1),
    method: DiscoveryRerankMethodSchema,
    top_k: z.number().int().positive(),
    candidate_count_in: z.number().int().nonnegative(),
    candidate_count_out: z.number().int().nonnegative(),
    model: z.string().min(1).optional(),
    reason: z.string().min(1).optional(),
  }),
  ranked_papers: z.array(DiscoveryRerankedPaperSchema),
});

export type DiscoveryRerankStatus = z.infer<typeof DiscoveryRerankStatusSchema>;
export type DiscoveryRerankMethod = z.infer<typeof DiscoveryRerankMethodSchema>;
export type DiscoveryRerankedPaper = z.infer<typeof DiscoveryRerankedPaperSchema>;
export type DiscoveryRerankArtifact = z.infer<typeof DiscoveryRerankArtifactSchema>;
