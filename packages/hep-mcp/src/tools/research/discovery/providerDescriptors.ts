import {
  DiscoveryProviderDescriptorSchema,
  type DiscoveryProviderDescriptor,
} from '@autoresearch/shared';
import { ARXIV_DISCOVERY_DESCRIPTOR } from '@autoresearch/arxiv-mcp/tooling';
import { OPENALEX_DISCOVERY_DESCRIPTOR } from '@autoresearch/openalex-mcp/tooling';

export const INSPIRE_DISCOVERY_DESCRIPTOR: DiscoveryProviderDescriptor = DiscoveryProviderDescriptorSchema.parse({
  provider: 'inspire',
  display_name: 'INSPIRE-HEP',
  capabilities: {
    supports_keyword_search: true,
    supports_semantic_search: false,
    supports_citation_graph: true,
    supports_fulltext: true,
    supports_source_download: true,
    supports_open_access_content: true,
  },
  supported_intents: ['known_item', 'keyword_search', 'citation_expansion', 'fulltext_search'],
  notes: 'Shared discovery descriptor for NEW-DISC-01/SEM-06 retrieval planning.',
});

export const DISCOVERY_PROVIDER_DESCRIPTORS: DiscoveryProviderDescriptor[] = [
  INSPIRE_DISCOVERY_DESCRIPTOR,
  DiscoveryProviderDescriptorSchema.parse(OPENALEX_DISCOVERY_DESCRIPTOR),
  DiscoveryProviderDescriptorSchema.parse(ARXIV_DISCOVERY_DESCRIPTOR),
];
