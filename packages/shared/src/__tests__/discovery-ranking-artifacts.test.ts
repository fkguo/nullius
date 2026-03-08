import { describe, expect, it } from 'vitest';

import {
  DiscoveryCandidateGenerationArtifactSchema,
  DiscoveryRerankArtifactSchema,
} from '../index.js';

describe('discovery ranking artifacts', () => {
  it('parses candidate-generation batches with channel/rank provenance', () => {
    const artifact = DiscoveryCandidateGenerationArtifactSchema.parse({
      version: 1,
      query: 'heavy flavor threshold states',
      normalized_query: 'heavy flavor threshold states',
      intent: 'keyword_search',
      batches: [
        {
          provider: 'openalex',
          channel: 'semantic_search',
          executed: true,
          reason: 'provider_native_semantic_search',
          result_count: 1,
          candidates: [
            {
              provider: 'openalex',
              identifiers: { openalex_id: 'W1', doi: '10.1000/example' },
              title: 'Heavy flavor spectroscopy with threshold states',
              authors: ['A. Author'],
              year: 2025,
              score: 0.91,
              matched_by: ['semantic_search'],
              provenance: {
                source: 'openalex_semantic_search',
                query: 'heavy flavor threshold states',
                channel: 'semantic_search',
                provider_rank: 1,
                provider_score: 0.91,
              },
            },
          ],
        },
      ],
    });

    expect(artifact.batches[0]?.candidates[0]?.provenance.channel).toBe('semantic_search');
    expect(artifact.batches[0]?.candidates[0]?.provenance.provider_rank).toBe(1);
  });

  it('parses rerank artifacts with explicit unavailable path', () => {
    const artifact = DiscoveryRerankArtifactSchema.parse({
      version: 1,
      query: '10.1000/example',
      status: 'unavailable',
      reranker: {
        name: 'canonical_paper_reranker',
        method: 'llm_listwise_rerank',
        top_k: 5,
        candidate_count_in: 3,
        candidate_count_out: 3,
        reason: 'sampling_unavailable',
      },
      ranked_papers: [
        {
          canonical_key: 'paper:doi:10.1000/example',
          score: 0.88,
          stage1_score: 0.88,
          reason_codes: ['exact_identifier_match'],
          provider_sources: ['inspire', 'openalex'],
          merge_state: 'confident_match',
        },
      ],
    });

    expect(artifact.status).toBe('unavailable');
    expect(artifact.reranker.reason).toBe('sampling_unavailable');
  });
});
