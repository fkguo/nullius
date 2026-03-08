import { z } from 'zod';

export const DiscoveryProviderResultCountsSchema = z.object({
  inspire: z.number().int().nonnegative(),
  openalex: z.number().int().nonnegative(),
  arxiv: z.number().int().nonnegative(),
});

export type DiscoveryProviderResultCounts = z.infer<typeof DiscoveryProviderResultCountsSchema>;
