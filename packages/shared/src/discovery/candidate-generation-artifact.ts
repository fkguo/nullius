import { z } from 'zod';
import { DiscoveryProviderIdSchema } from './capabilities.js';
import { CanonicalCandidateSchema } from './canonical-candidate.js';
import { DiscoveryCandidateChannelSchema } from './candidate-channel.js';
import { DiscoveryQueryIntentSchema } from './query-intent.js';

export const DiscoveryCandidateBatchSchema = z.object({
  provider: DiscoveryProviderIdSchema,
  channel: DiscoveryCandidateChannelSchema,
  executed: z.boolean(),
  reason: z.string().min(1),
  result_count: z.number().int().nonnegative(),
  candidates: z.array(CanonicalCandidateSchema).default([]),
});

export const DiscoveryCandidateGenerationArtifactSchema = z.object({
  version: z.literal(1),
  query: z.string().min(1),
  normalized_query: z.string().min(1),
  intent: DiscoveryQueryIntentSchema,
  batches: z.array(DiscoveryCandidateBatchSchema),
});

export type DiscoveryCandidateBatch = z.infer<typeof DiscoveryCandidateBatchSchema>;
export type DiscoveryCandidateGenerationArtifact = z.infer<typeof DiscoveryCandidateGenerationArtifactSchema>;
