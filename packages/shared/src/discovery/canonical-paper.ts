import { z } from 'zod';
import { PaperIdentifiersSchema } from '../types/identifiers.js';
import { DiscoveryProviderIdSchema } from './capabilities.js';
import { CanonicalCandidateSchema } from './canonical-candidate.js';

export const CanonicalPaperMergeStateSchema = z.enum([
  'single_source',
  'confident_match',
  'uncertain_match',
]);

export const CanonicalPaperMergeConfidenceSchema = z.enum(['low', 'medium', 'high']);

export const CanonicalPaperSchema = z.object({
  canonical_key: z.string().min(1),
  identifiers: PaperIdentifiersSchema,
  title: z.string().min(1),
  authors: z.array(z.string()).default([]),
  year: z.number().int().optional(),
  citation_count: z.number().int().nonnegative().optional(),
  provider_sources: z.array(DiscoveryProviderIdSchema).min(1),
  merge_state: CanonicalPaperMergeStateSchema,
  merge_confidence: CanonicalPaperMergeConfidenceSchema,
  match_reasons: z.array(z.string()).default([]),
  uncertain_group_key: z.string().min(1).optional(),
  source_candidates: z.array(CanonicalCandidateSchema).min(1),
});

export const DiscoveryCanonicalPapersArtifactSchema = z.object({
  version: z.literal(1),
  query: z.string().min(1),
  papers: z.array(CanonicalPaperSchema),
});

export type CanonicalPaper = z.infer<typeof CanonicalPaperSchema>;
export type DiscoveryCanonicalPapersArtifact = z.infer<typeof DiscoveryCanonicalPapersArtifactSchema>;
