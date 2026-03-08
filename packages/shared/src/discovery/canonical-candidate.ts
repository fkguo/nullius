import { z } from 'zod';
import { PaperIdentifiersSchema } from '../types/identifiers.js';
import { DiscoveryProviderIdSchema } from './capabilities.js';

export const CanonicalCandidateSchema = z.object({
  provider: DiscoveryProviderIdSchema,
  identifiers: PaperIdentifiersSchema,
  title: z.string().min(1),
  authors: z.array(z.string()).default([]),
  year: z.number().int().optional(),
  citation_count: z.number().int().nonnegative().optional(),
  score: z.number().min(0).max(1).optional(),
  matched_by: z.array(z.string()).default([]),
  provenance: z.object({
    source: z.string().min(1),
    query: z.string().optional(),
  }),
});

export type CanonicalCandidate = z.infer<typeof CanonicalCandidateSchema>;
