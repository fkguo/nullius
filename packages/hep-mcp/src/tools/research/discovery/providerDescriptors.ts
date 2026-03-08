import {
  DiscoveryProviderDescriptorSchema,
  type DiscoveryProviderDescriptor,
} from '@autoresearch/shared';

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

export const OPENALEX_DISCOVERY_DESCRIPTOR: DiscoveryProviderDescriptor = DiscoveryProviderDescriptorSchema.parse({
  provider: 'openalex',
  display_name: 'OpenAlex',
  capabilities: {
    supports_keyword_search: true,
    supports_semantic_search: true,
    supports_citation_graph: true,
    supports_fulltext: false,
    supports_source_download: false,
    supports_open_access_content: true,
  },
  supported_intents: ['known_item', 'keyword_search', 'semantic_search', 'citation_expansion'],
  notes: 'OpenAlex-backed discovery descriptor for broker planning.',
});

export const ARXIV_DISCOVERY_DESCRIPTOR: DiscoveryProviderDescriptor = DiscoveryProviderDescriptorSchema.parse({
  provider: 'arxiv',
  display_name: 'arXiv',
  capabilities: {
    supports_keyword_search: true,
    supports_semantic_search: false,
    supports_citation_graph: false,
    supports_fulltext: false,
    supports_source_download: true,
    supports_open_access_content: true,
  },
  supported_intents: ['known_item', 'keyword_search'],
  notes: 'arXiv metadata/source discovery descriptor for broker planning.',
});

export const DISCOVERY_PROVIDER_DESCRIPTORS: DiscoveryProviderDescriptor[] = [
  INSPIRE_DISCOVERY_DESCRIPTOR,
  OPENALEX_DISCOVERY_DESCRIPTOR,
  ARXIV_DISCOVERY_DESCRIPTOR,
];
