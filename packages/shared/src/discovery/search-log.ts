import { z } from 'zod';
import { DiscoveryProviderIdSchema } from './capabilities.js';
import { DiscoveryQueryIntentSchema } from './query-intent.js';

export const DiscoveryArtifactLocatorSchema = z.object({
  artifact_name: z.string().min(1),
  file_path: z.string().min(1),
});

export const DiscoveryProviderResultCountsSchema = z.object({
  inspire: z.number().int().nonnegative(),
  openalex: z.number().int().nonnegative(),
  arxiv: z.number().int().nonnegative(),
});

export const DiscoverySearchLogEntrySchema = z.object({
  version: z.literal(1),
  request_index: z.number().int().positive(),
  logged_at: z.string().min(1),
  query: z.string().min(1),
  normalized_query: z.string().min(1),
  intent: DiscoveryQueryIntentSchema,
  selected_providers: z.array(DiscoveryProviderIdSchema),
  provider_result_counts: DiscoveryProviderResultCountsSchema,
  canonical_paper_count: z.number().int().nonnegative(),
  uncertain_group_count: z.number().int().nonnegative(),
  artifact_locators: z.array(DiscoveryArtifactLocatorSchema).min(1),
});

export type DiscoveryArtifactLocator = z.infer<typeof DiscoveryArtifactLocatorSchema>;
export type DiscoverySearchLogEntry = z.infer<typeof DiscoverySearchLogEntrySchema>;

export function appendDiscoverySearchLogEntries(
  existing: DiscoverySearchLogEntry[],
  ...entries: DiscoverySearchLogEntry[]
): DiscoverySearchLogEntry[] {
  return [
    ...existing.map(entry => DiscoverySearchLogEntrySchema.parse(entry)),
    ...entries.map(entry => DiscoverySearchLogEntrySchema.parse(entry)),
  ];
}
