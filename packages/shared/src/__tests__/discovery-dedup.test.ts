import { describe, expect, it } from 'vitest';

import {
  DiscoverySearchLogEntrySchema,
  appendDiscoverySearchLogEntries,
  canonicalizeDiscoveryCandidates,
  planDiscoveryProviders,
  type CanonicalCandidate,
  type DiscoveryProviderDescriptor,
} from '../index.js';

const descriptors: DiscoveryProviderDescriptor[] = [
  {
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
    supported_intents: ['known_item', 'keyword_search', 'semantic_search', 'citation_expansion', 'fulltext_search'],
  },
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
];

describe('discovery dedup and log artifacts', () => {
  it('keeps near-duplicates as uncertain instead of force-merging', () => {
    const candidates: CanonicalCandidate[] = [
      {
        provider: 'inspire',
        identifiers: { recid: '1001' },
        title: 'Heavy-flavor spectroscopy with near-threshold states',
        authors: ['A. Author', 'B. Author'],
        year: 2024,
        matched_by: ['keyword_search'],
        provenance: { source: 'inspire_search', query: 'near-threshold heavy flavor' },
      },
      {
        provider: 'openalex',
        identifiers: { openalex_id: 'W1001' },
        title: 'Heavy flavor spectroscopy with near threshold states',
        authors: ['A. Author', 'C. Collaborator'],
        year: 2024,
        matched_by: ['keyword_search'],
        provenance: { source: 'openalex_search', query: 'near-threshold heavy flavor' },
      },
    ];

    const result = canonicalizeDiscoveryCandidates({
      query: 'near-threshold heavy flavor',
      candidates,
    });

    expect(result.papers).toHaveLength(2);
    expect(result.dedup.confident_merges).toHaveLength(0);
    expect(result.dedup.uncertain_groups).toHaveLength(1);
    expect(result.dedup.non_merges).toHaveLength(0);
    expect(result.papers.every(paper => paper.merge_state === 'uncertain_match')).toBe(true);
  });

  it('captures provider-selection rationale in the query plan', () => {
    const plan = planDiscoveryProviders(
      {
        intent: 'semantic_search',
        query: 'lattice QCD review',
        preferred_providers: ['openalex'],
        required_capabilities: ['supports_semantic_search'],
      },
      descriptors,
    );

    expect(plan.selected_providers).toEqual(['openalex']);
    expect(plan.provider_decisions.find(step => step.provider === 'openalex')?.selected).toBe(true);
    expect(plan.provider_decisions.find(step => step.provider === 'arxiv')?.reason_codes).toContain('missing_capability:supports_semantic_search');
    expect(plan.provider_decisions.find(step => step.provider === 'inspire')?.reason_codes).toContain('missing_capability:supports_semantic_search');
  });

  it('preserves append-only search-log semantics', () => {
    const first = DiscoverySearchLogEntrySchema.parse({
      version: 1,
      request_index: 1,
      logged_at: '2026-03-07T00:00:00.000Z',
      query: '10.1000/example',
      normalized_query: '10.1000/example',
      intent: 'known_item',
      selected_providers: ['inspire', 'openalex'],
      provider_result_counts: { inspire: 1, openalex: 1, arxiv: 0 },
      canonical_paper_count: 1,
      uncertain_group_count: 0,
      artifact_locators: [
        {
          artifact_name: 'discovery_query_plan_001_v1.json',
          file_path: '/tmp/discovery_query_plan_001_v1.json',
        },
      ],
    });
    const second = DiscoverySearchLogEntrySchema.parse({
      version: 1,
      request_index: 2,
      logged_at: '2026-03-07T00:01:00.000Z',
      query: 'near-threshold heavy flavor',
      normalized_query: 'near-threshold heavy flavor',
      intent: 'keyword_search',
      selected_providers: ['inspire'],
      provider_result_counts: { inspire: 2, openalex: 0, arxiv: 0 },
      canonical_paper_count: 2,
      uncertain_group_count: 1,
      artifact_locators: [
        {
          artifact_name: 'discovery_query_plan_002_v1.json',
          file_path: '/tmp/discovery_query_plan_002_v1.json',
        },
      ],
    });

    const appended = appendDiscoverySearchLogEntries([first], second);
    expect(appended).toHaveLength(2);
    expect(appended[0]).toEqual(first);
    expect(appended[1]).toEqual(second);
  });
});
