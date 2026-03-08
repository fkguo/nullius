import { z } from 'zod';

export const DiscoveryCandidateChannelSchema = z.enum([
  'identifier_lookup',
  'keyword_search',
  'semantic_search',
  'override',
]);

export type DiscoveryCandidateChannel = z.infer<typeof DiscoveryCandidateChannelSchema>;
