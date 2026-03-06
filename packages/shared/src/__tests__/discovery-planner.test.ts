import { describe, expect, it } from 'vitest';
import { planDiscoveryProviders, type DiscoveryProviderDescriptor } from '../discovery/index.js';

const descriptors: DiscoveryProviderDescriptor[] = [
  {
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
    supported_intents: ['known_item', 'keyword_search', 'fulltext_search'],
  },
  {
    provider: 'openalex',
    display_name: 'OpenAlex',
    capabilities: {
      supports_keyword_search: true,
      supports_semantic_search: true,
      supports_citation_graph: true,
      supports_fulltext: true,
      supports_source_download: false,
      supports_open_access_content: true,
    },
    supported_intents: ['known_item', 'keyword_search', 'semantic_search', 'citation_expansion'],
  },
];

describe('planDiscoveryProviders', () => {
  it('prioritizes preferred providers while enforcing capability requirements', () => {
    const plan = planDiscoveryProviders(
      {
        intent: 'semantic_search',
        query: 'lattice QCD review',
        preferred_providers: ['openalex', 'arxiv'],
        required_capabilities: ['supports_semantic_search'],
      },
      descriptors,
    );

    expect(plan.selected_providers).toEqual(['openalex']);
    expect(plan.steps[0]?.reason).toContain('preferred_provider');
  });

  it('returns all compatible providers for keyword search', () => {
    const plan = planDiscoveryProviders(
      {
        intent: 'keyword_search',
        query: 'dark matter direct detection',
      },
      descriptors,
    );

    expect(plan.selected_providers).toEqual(['arxiv', 'openalex']);
  });
});
