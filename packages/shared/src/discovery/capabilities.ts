import { z } from 'zod';

export const DiscoveryProviderIdSchema = z.enum(['inspire', 'openalex', 'arxiv']);

export const DiscoveryCapabilityNameSchema = z.enum([
  'supports_keyword_search',
  'supports_semantic_search',
  'supports_citation_graph',
  'supports_fulltext',
  'supports_source_download',
  'supports_open_access_content',
]);

export const DiscoveryProviderCapabilitiesSchema = z.object({
  supports_keyword_search: z.boolean().default(false),
  supports_semantic_search: z.boolean().default(false),
  supports_citation_graph: z.boolean().default(false),
  supports_fulltext: z.boolean().default(false),
  supports_source_download: z.boolean().default(false),
  supports_open_access_content: z.boolean().default(false),
});

export type DiscoveryProviderId = z.infer<typeof DiscoveryProviderIdSchema>;
export type DiscoveryCapabilityName = z.infer<typeof DiscoveryCapabilityNameSchema>;
export type DiscoveryProviderCapabilities = z.infer<typeof DiscoveryProviderCapabilitiesSchema>;

export function supportsCapabilities(
  capabilities: DiscoveryProviderCapabilities,
  required: DiscoveryCapabilityName[],
): boolean {
  return required.every(capability => capabilities[capability] === true);
}
