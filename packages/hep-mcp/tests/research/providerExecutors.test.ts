import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ARXIV_GET_METADATA, ARXIV_SEARCH, OPENALEX_GET, OPENALEX_SEARCH, OPENALEX_SEMANTIC_SEARCH, type DiscoveryPlan } from '@autoresearch/shared';

const search = vi.fn();
const getByDoi = vi.fn();
const getByArxiv = vi.fn();
const getPaper = vi.fn();
const openAlexGet = vi.fn();
const openAlexSearch = vi.fn();
const openAlexSemantic = vi.fn();
const arxivGet = vi.fn();
const arxivSearch = vi.fn();

vi.mock('../../src/api/client.js', () => ({ search, getByDoi, getByArxiv, getPaper }));
vi.mock('@autoresearch/openalex-mcp/tooling', () => ({
  getToolSpecs: () => [
    { name: OPENALEX_GET, handler: openAlexGet },
    { name: OPENALEX_SEARCH, handler: openAlexSearch },
    { name: OPENALEX_SEMANTIC_SEARCH, handler: openAlexSemantic },
  ],
}));
vi.mock('@autoresearch/arxiv-mcp/tooling', () => ({
  normalizeArxivId: (id: string) => id,
  getToolSpec: (name: string) => ({ name, handler: name === ARXIV_GET_METADATA ? arxivGet : arxivSearch }),
}));

const { runHybridCandidateGeneration } = await import('../../src/tools/research/discovery/providerExecutors.js');

function plan(query: string, intent: DiscoveryPlan['intent'], selected_providers: DiscoveryPlan['selected_providers']): DiscoveryPlan {
  return {
    version: 1,
    query,
    normalized_query: query,
    intent,
    preferred_providers: [],
    required_capabilities: [],
    selected_providers,
    steps: selected_providers.map(provider => ({ provider, reason: 'fixture' })),
    provider_decisions: selected_providers.map((provider, index) => ({ provider, display_name: provider, selected: true, order: index + 1, reason_codes: ['fixture'] })),
  };
}

describe('runHybridCandidateGeneration', () => {
  const originalApiKey = process.env.OPENALEX_API_KEY;

  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.OPENALEX_API_KEY;
  });

  afterEach(() => {
    if (originalApiKey === undefined) delete process.env.OPENALEX_API_KEY;
    else process.env.OPENALEX_API_KEY = originalApiKey;
  });

  it('combines identifier + keyword batches and skips semantic for structured-ID queries', async () => {
    getByDoi.mockResolvedValue({ recid: '1001', doi: '10.1000/exact', arxiv_id: '2501.00001', title: 'Exact known-item retrieval across providers', authors: ['A. Exact'], year: 2025, citation_count: 10 });
    search.mockResolvedValue({ papers: [{ recid: '1001', doi: '10.1000/exact', arxiv_id: '2501.00001', title: 'Exact known-item retrieval across providers', authors: ['A. Exact'], year: 2025, citation_count: 10 }] });
    openAlexGet.mockResolvedValue({ result: { id: 'https://openalex.org/W1001', doi: 'https://doi.org/10.1000/exact', title: 'Exact known-item retrieval across providers', publication_year: 2025, cited_by_count: 20, authorships: [] } });
    openAlexSearch.mockResolvedValue({ results: [{ id: 'https://openalex.org/W1001', doi: 'https://doi.org/10.1000/exact', title: 'Exact known-item retrieval across providers', publication_year: 2025, cited_by_count: 20, authorships: [] }] });
    arxivGet.mockResolvedValue({ arxiv_id: '2501.00001', title: 'Exact known-item retrieval across providers', authors: ['A. Exact'], doi: '10.1000/exact', published: '2025-01-01T00:00:00Z' });
    arxivSearch.mockResolvedValue({ entries: [{ arxiv_id: '2501.00001', title: 'Exact known-item retrieval across providers', authors: ['A. Exact'], doi: '10.1000/exact', published: '2025-01-01T00:00:00Z' }] });

    const batches = await runHybridCandidateGeneration(plan('10.1000/exact', 'known_item', ['inspire', 'openalex', 'arxiv']), 5);
    expect(batches.map(batch => `${batch.provider}:${batch.channel}:${batch.executed}`)).toEqual([
      'inspire:identifier_lookup:true',
      'inspire:keyword_search:true',
      'inspire:semantic_search:false',
      'openalex:identifier_lookup:true',
      'openalex:keyword_search:true',
      'openalex:semantic_search:false',
      'arxiv:identifier_lookup:false',
      'arxiv:keyword_search:true',
      'arxiv:semantic_search:false',
    ]);
    expect(search).toHaveBeenCalledWith('10.1000/exact', { size: 5 });
    expect(batches.find(batch => batch.provider === 'openalex' && batch.channel === 'semantic_search')?.reason).toBe('structured_identifier_query_prefers_exact_lookup');
  });

  it('executes provider-native semantic search for openalex when available', async () => {
    process.env.OPENALEX_API_KEY = 'test-key';
    openAlexSearch.mockResolvedValue({ results: [] });
    openAlexSemantic.mockResolvedValue({ results: [{ id: 'https://openalex.org/W2001', title: 'Semantic candidate for displaced vertices', publication_year: 2025, cited_by_count: 5, authorships: [] }] });

    const batches = await runHybridCandidateGeneration(plan('displaced vertex heavy neutral lepton atlas', 'semantic_search', ['openalex']), 5);
    expect(batches.map(batch => `${batch.channel}:${batch.executed}`)).toEqual([
      'identifier_lookup:false',
      'keyword_search:true',
      'semantic_search:true',
    ]);
    expect(batches[2]?.result_count).toBe(1);
  });
});
