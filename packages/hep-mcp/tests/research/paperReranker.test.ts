import { describe, expect, it } from 'vitest';

import type { CanonicalPaper } from '@autoresearch/shared';
import { rerankCanonicalPapers } from '../../src/tools/research/discovery/paperReranker.js';

function makePaper(input: Partial<CanonicalPaper> & Pick<CanonicalPaper, 'canonical_key' | 'title'>): CanonicalPaper {
  return {
    canonical_key: input.canonical_key,
    identifiers: input.identifiers ?? {},
    title: input.title,
    authors: input.authors ?? [],
    year: input.year,
    citation_count: input.citation_count,
    provider_sources: input.provider_sources ?? ['inspire'],
    merge_state: input.merge_state ?? 'single_source',
    merge_confidence: input.merge_confidence ?? 'medium',
    match_reasons: input.match_reasons ?? ['single_provider_result'],
    source_candidates: input.source_candidates ?? [{
      provider: 'inspire',
      identifiers: input.identifiers ?? {},
      title: input.title,
      authors: input.authors ?? [],
      year: input.year,
      citation_count: input.citation_count,
      matched_by: ['fixture'],
      provenance: { source: 'fixture' },
    }],
  };
}

describe('paper reranker', () => {
  it('fails closed when sampling is unavailable', async () => {
    const gold = makePaper({ canonical_key: 'paper:doi:10.1000/exact', title: 'Exact known item', identifiers: { doi: '10.1000/exact' }, provider_sources: ['inspire', 'openalex'], match_reasons: ['exact_doi'] });
    const decoy = makePaper({ canonical_key: 'paper:arxiv:2501.00002', title: 'Exact known item review', identifiers: { arxiv_id: '2501.00002' }, citation_count: 500 });
    const result = await rerankCanonicalPapers({ query: '10.1000/exact', papers: [decoy, gold], limit: 10 });
    expect(result.artifact.status).toBe('unavailable');
    expect(result.papers[0]?.canonical_key).toBe('paper:doi:10.1000/exact');
  });

  it('uses listwise sampling to improve a hard author-year query', async () => {
    const gold = makePaper({ canonical_key: 'paper:doi:10.1000/prompt-photon-gold', title: 'Prompt photon constraints on exotic charm', identifiers: { doi: '10.1000/prompt-photon-gold' }, authors: ['J. Smith'], year: 2024, citation_count: 20, provider_sources: ['inspire', 'openalex'], match_reasons: ['exact_doi'] });
    const decoy = makePaper({ canonical_key: 'paper:arxiv:2502.00002', title: 'Prompt photon anomalies review', identifiers: { arxiv_id: '2502.00002' }, authors: ['B. Brown'], year: 2025, citation_count: 500 });
    const result = await rerankCanonicalPapers({
      query: 'Smith 2024 prompt photon anomalies',
      papers: [gold, decoy],
      limit: 10,
      createMessage: async () => ({
        role: 'assistant',
        model: 'mock-reranker',
        content: [{ type: 'text', text: JSON.stringify({ abstain: false, reason: 'ranked_fixture', ranked: [
          { canonical_key: gold.canonical_key, score: 0.98, reason_codes: ['author_year_match'] },
          { canonical_key: decoy.canonical_key, score: 0.42, reason_codes: ['review_decoy'] },
        ] }) }],
      }) as never,
    });

    expect(result.artifact.status).toBe('applied');
    expect(result.artifact.ranked_papers[0]?.canonical_key).toBe(gold.canonical_key);
    expect(result.papers[0]?.canonical_key).toBe(gold.canonical_key);
  });

  it('marks insufficient-candidate paths explicitly', async () => {
    const solo = makePaper({ canonical_key: 'paper:doi:10.1000/solo', title: 'Solo candidate retrieval evidence', identifiers: { doi: '10.1000/solo' }, match_reasons: ['exact_doi'] });
    const result = await rerankCanonicalPapers({ query: '10.1000/solo', papers: [solo], limit: 10 });
    expect(result.artifact.status).toBe('insufficient_candidates');
    expect(result.papers).toHaveLength(1);
  });
});
