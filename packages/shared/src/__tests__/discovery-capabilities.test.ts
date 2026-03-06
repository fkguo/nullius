import { describe, expect, it } from 'vitest';
import {
  DiscoveryProviderCapabilitiesSchema,
  DiscoveryProviderDescriptorSchema,
  PaperIdentifiersSchema,
  PaperSummarySchema,
} from '../index.js';

describe('discovery capability schema', () => {
  it('accepts openalex_id in shared paper identifiers and summaries', () => {
    expect(PaperIdentifiersSchema.parse({ openalex_id: 'W2741809807' })).toEqual({ openalex_id: 'W2741809807' });
    expect(
      PaperSummarySchema.parse({
        title: 'OpenAlex-linked paper',
        authors: ['A. Author'],
        openalex_id: 'W2741809807',
      }).openalex_id,
    ).toBe('W2741809807');
  });

  it('parses provider capability descriptors from shared schema', () => {
    const descriptor = DiscoveryProviderDescriptorSchema.parse({
      provider: 'openalex',
      display_name: 'OpenAlex',
      capabilities: DiscoveryProviderCapabilitiesSchema.parse({
        supports_keyword_search: true,
        supports_semantic_search: true,
        supports_citation_graph: true,
        supports_fulltext: true,
        supports_source_download: false,
        supports_open_access_content: true,
      }),
      supported_intents: ['known_item', 'keyword_search', 'semantic_search', 'citation_expansion'],
    });

    expect(descriptor.capabilities.supports_semantic_search).toBe(true);
  });
});
