import { z } from 'zod';
import { DiscoveryProviderIdSchema } from './capabilities.js';
import { CanonicalCandidateSchema } from './canonical-candidate.js';

const DiscoveryConfidentMergeSchema = z.object({
  canonical_key: z.string().min(1),
  provider_sources: z.array(DiscoveryProviderIdSchema).min(1),
  merged_candidate_count: z.number().int().positive(),
  match_reasons: z.array(z.string()).min(1),
  source_candidates: z.array(CanonicalCandidateSchema).min(2),
});

const DiscoveryUncertainGroupSchema = z.object({
  group_key: z.string().min(1),
  match_reasons: z.array(z.string()).min(1),
  source_candidates: z.array(CanonicalCandidateSchema).min(2),
});

const DiscoveryNonMergeSchema = z.object({
  pair_key: z.string().min(1),
  reason_codes: z.array(z.string()).min(1),
  source_candidates: z.array(CanonicalCandidateSchema).length(2),
});

export const DiscoveryDedupArtifactSchema = z.object({
  version: z.literal(1),
  query: z.string().min(1),
  confident_merges: z.array(DiscoveryConfidentMergeSchema),
  uncertain_groups: z.array(DiscoveryUncertainGroupSchema),
  non_merges: z.array(DiscoveryNonMergeSchema),
});

export type DiscoveryDedupArtifact = z.infer<typeof DiscoveryDedupArtifactSchema>;
