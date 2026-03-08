import { describe, expect, it } from 'vitest';

import {
  DiscoveryCandidateGenerationArtifactSchema,
  DiscoveryQueryReformulationArtifactSchema,
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

  it('parses triggered reformulation artifacts with explicit telemetry', () => {
    const artifact = DiscoveryQueryReformulationArtifactSchema.parse({
      version: 1,
      original_query: 'Smith 2024 prompt photon anomalies',
      effective_query: 'Prompt photon constraints on exotic charm Smith 2024',
      normalized_effective_query: 'prompt photon constraints on exotic charm smith 2024',
      qpp: {
        status: 'applied',
        difficulty: 'high',
        ambiguity: 'high',
        low_recall_risk: 'high',
        trigger_decision: 'triggered',
        reason_codes: ['author_year_fragment', 'weak_probe_recall'],
      },
      probe: {
        structured_identifier_detected: false,
        author_year_hint: true,
        acronym_hint: false,
        verbose_query: false,
        low_anchor_density: true,
        provider_result_counts: { inspire: 1, openalex: 2, arxiv: 1 },
        candidate_count: 4,
        canonical_paper_count: 3,
        exact_identifier_hit: false,
        top_stage1_score: 0.48,
        top_title_overlap: 0.4,
        top_provider_source_count: 1,
        top_stage1_canonical_keys: ['paper:arxiv:2502.00002', 'paper:doi:10.1000/prompt-photon-gold'],
      },
      reformulation: {
        status: 'applied',
        reason: 'query_rewritten',
        reformulated_query: 'Prompt photon constraints on exotic charm Smith 2024',
        reason_codes: ['single_turn_rewrite'],
      },
      telemetry: {
        sampling_calls: 1,
        reformulation_count: 1,
        extra_provider_round_trips: 1,
      },
    });

    expect(artifact.qpp.trigger_decision).toBe('triggered');
    expect(artifact.telemetry.sampling_calls).toBe(1);
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
