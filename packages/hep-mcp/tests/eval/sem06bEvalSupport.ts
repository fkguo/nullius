import { mrrAtK, ndcgAtK, recallAtK, type EvalResult } from '../../src/eval/index.js';
import type { FederatedDiscoveryResult, DiscoveryProviderExecutors } from '../../src/tools/research/federatedDiscovery.js';
import type { CanonicalCandidate, DiscoveryProviderId, DiscoveryQueryIntent } from '@autoresearch/shared';

export type FixtureCandidate = {
  title: string;
  identifiers: CanonicalCandidate['identifiers'];
  authors?: string[];
  year?: number;
  citation_count?: number;
};

export type Sem06bInput = {
  query: string;
  intent: DiscoveryQueryIntent;
  providers: Partial<Record<DiscoveryProviderId, FixtureCandidate[]>>;
  rerank: {
    mode: 'applied' | 'unavailable' | 'insufficient_candidates';
    ranked_keys?: string[];
  };
};

export type Sem06bExpected = {
  gold_canonical_key: string;
  provider_hit_providers: DiscoveryProviderId[];
  canonical_count: number;
  expected_rerank_status: 'applied' | 'unavailable' | 'insufficient_candidates';
  max_final_rank: number;
  min_stage1_rank?: number;
};

export type Sem06bActual = FederatedDiscoveryResult;

function avg(results: Array<EvalResult<Sem06bActual>>, name: string): number {
  return results.reduce((sum, result) => sum + (result.metrics[name] ?? 0), 0) / Math.max(results.length, 1);
}

function makeCandidate(provider: DiscoveryProviderId, query: string, input: FixtureCandidate, index: number): CanonicalCandidate {
  return {
    provider,
    identifiers: input.identifiers,
    title: input.title,
    authors: input.authors ?? [],
    year: input.year,
    citation_count: input.citation_count,
    matched_by: ['fixture'],
    provenance: {
      source: `${provider}_fixture`,
      query,
      channel: 'override',
      provider_rank: index + 1,
      provider_score: Math.max(0, 1 - index * 0.05),
    },
  };
}

export function buildExecutors(input: Sem06bInput): DiscoveryProviderExecutors {
  const build = (provider: DiscoveryProviderId) => async () => {
    const candidates = (input.providers[provider] ?? []).map((candidate, index) => makeCandidate(provider, input.query, candidate, index));
    return { provider, query: input.query, candidates, result_count: candidates.length };
  };
  return {
    inspire: build('inspire'),
    openalex: build('openalex'),
    arxiv: build('arxiv'),
  };
}

export function buildCreateMessage(input: Sem06bInput) {
  if (input.rerank.mode !== 'applied') return undefined;
  const ranked = (input.rerank.ranked_keys ?? []).map((canonical_key, index) => ({
    canonical_key,
    score: Math.max(0.1, 1 - index * 0.15),
    reason_codes: index === 0 ? ['author_year_match', 'cross_provider_agreement'] : ['lower_confidence'],
  }));
  return async () => ({
    role: 'assistant',
    model: 'mock-reranker',
    content: [{ type: 'text', text: JSON.stringify({ abstain: false, reason: 'ranked_fixture', ranked }) }],
  }) as never;
}

function rankOf(keys: string[], target: string): number | null {
  const index = keys.indexOf(target);
  return index >= 0 ? index + 1 : null;
}

function stage1Keys(actual: Sem06bActual): string[] {
  return [...actual.rerank.ranked_papers]
    .sort((left, right) => (right.stage1_score ?? 0) - (left.stage1_score ?? 0) || left.canonical_key.localeCompare(right.canonical_key))
    .map(item => item.canonical_key);
}

export function judgeSem06b(expected: unknown, actual: Sem06bActual) {
  const exp = expected as Sem06bExpected;
  const providerHits = actual.provider_results.filter(result => result.result_count > 0).map(result => result.provider);
  const finalKeys = actual.papers.map(paper => paper.canonical_key);
  const finalRank = rankOf(finalKeys, exp.gold_canonical_key);
  const stage1Rank = rankOf(stage1Keys(actual), exp.gold_canonical_key);
  const statusOk = actual.rerank.status === exp.expected_rerank_status;
  const providersOk = JSON.stringify(providerHits) === JSON.stringify(exp.provider_hit_providers);
  const canonicalOk = actual.papers.length === exp.canonical_count;
  const finalOk = finalRank !== null && finalRank <= exp.max_final_rank;
  const hardOk = exp.min_stage1_rank === undefined || (stage1Rank !== null && stage1Rank >= exp.min_stage1_rank);
  return {
    passed: statusOk && providersOk && canonicalOk && finalOk && hardOk,
    metrics: {
      known_item_hit_rate: finalRank === 1 ? 1 : 0,
      recall_at_3: recallAtK([finalRank], 3),
      mrr_at_10: mrrAtK([finalRank], 10),
      ndcg_at_10: ndcgAtK(finalKeys.map(key => (key === exp.gold_canonical_key ? 1 : 0)), 10),
      failure_path_guard: statusOk ? 1 : 0,
      rerank_improved: exp.min_stage1_rank === undefined ? 1 : finalRank !== null && stage1Rank !== null && finalRank < stage1Rank ? 1 : 0,
    },
  };
}

export function aggregateSem06b(results: Array<EvalResult<Sem06bActual>>) {
  const hard = results.filter(result => result.tags.includes('hard_query'));
  const failure = results.filter(result => ['unavailable', 'insufficient_candidates'].includes((result.expected as Sem06bExpected).expected_rerank_status));
  const rerankGain = results.filter(result => result.tags.includes('rerank_gain'));
  return {
    known_item_hit_rate_overall: avg(results, 'known_item_hit_rate'),
    recall_at_3_hard_query: avg(hard, 'recall_at_3'),
    mrr_at_10_overall: avg(results, 'mrr_at_10'),
    ndcg_at_10_overall: avg(results, 'ndcg_at_10'),
    failure_path_guard_overall: avg(failure, 'failure_path_guard'),
    rerank_improvement_rate: avg(rerankGain, 'rerank_improved'),
  };
}
