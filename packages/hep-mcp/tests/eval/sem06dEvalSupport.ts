import { mrrAtK, ndcgAtK, recallAtK, type EvalResult } from '../../src/eval/index.js';
import type {
  FederatedDiscoveryResult,
  DiscoveryProviderExecutors,
  DiscoveryQppAssessor,
} from '../../src/tools/research/federatedDiscovery.js';
import type {
  CanonicalCandidate,
  DiscoveryProviderId,
  DiscoveryQueryIntent,
  DiscoveryQueryReformulationArtifact,
} from '@autoresearch/shared';

export type FixtureCandidate = {
  title: string;
  identifiers: CanonicalCandidate['identifiers'];
  authors?: string[];
  year?: number;
  citation_count?: number;
};

export type Sem06dInput = {
  query: string;
  intent: DiscoveryQueryIntent;
  providers: {
    original: Partial<Record<DiscoveryProviderId, FixtureCandidate[]>>;
    reformulated?: Partial<Record<DiscoveryProviderId, FixtureCandidate[]>>;
  };
  assessment?: { mode: 'default' | 'unavailable' | 'invalid' };
  reformulation?: {
    mode: 'applied' | 'abstain' | 'invalid' | 'unavailable';
    query?: string;
  };
  rerank: {
    mode: 'applied' | 'unavailable' | 'insufficient_candidates';
    ranked_keys?: string[];
  };
  budget?: {
    max_sampling_calls?: number;
  };
};

export type Sem06dExpected = {
  gold_canonical_key: string;
  provider_hit_providers: DiscoveryProviderId[];
  canonical_count: number;
  expected_trigger_decision: 'triggered' | 'not_triggered';
  expected_qpp_status: 'applied' | 'unavailable' | 'invalid';
  expected_reformulation_status: 'applied' | 'not_triggered' | 'abstained' | 'unavailable' | 'invalid' | 'budget_exhausted';
  expected_effective_query: string;
  expected_rerank_status: 'applied' | 'unavailable' | 'insufficient_candidates';
  max_final_rank: number;
  min_probe_rank?: number;
  expected_sampling_calls: number;
};

export type Sem06dActual = FederatedDiscoveryResult;

function avg(results: Array<EvalResult<Sem06dActual>>, name: string): number {
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

export function buildExecutors(input: Sem06dInput): DiscoveryProviderExecutors {
  const build = (provider: DiscoveryProviderId) => async (request: { query: string }) => {
    const source = request.query === input.query
      ? input.providers.original[provider]
      : request.query === input.reformulation?.query
        ? input.providers.reformulated?.[provider]
        : [];
    const candidates = (source ?? []).map((candidate, index) => makeCandidate(provider, request.query, candidate, index));
    return { provider, query: request.query, candidates, result_count: candidates.length };
  };
  return {
    inspire: build('inspire'),
    openalex: build('openalex'),
    arxiv: build('arxiv'),
  };
}

export function buildAssessQuery(input: Sem06dInput): DiscoveryQppAssessor | undefined {
  if (!input.assessment || input.assessment.mode === 'default') return undefined;
  if (input.assessment.mode === 'unavailable') {
    return () => {
      throw new Error('qpp_unavailable_fixture');
    };
  }
  return () => ({ status: 'oops' } as never);
}

export function buildCreateMessage(input: Sem06dInput) {
  return async (params: { metadata?: { module?: string } }) => {
    const module = params.metadata?.module;
    if (module === 'sem06d_query_reformulator') {
      if (!input.reformulation) {
        throw new Error('unexpected_reformulation_request');
      }
      if (input.reformulation.mode === 'unavailable') {
        throw new Error('reformulation_sampling_unavailable');
      }
      if (input.reformulation.mode === 'invalid') {
        return { role: 'assistant', model: 'mock-reformulator', content: [{ type: 'text', text: 'not-json' }] } as never;
      }
      if (input.reformulation.mode === 'abstain') {
        return { role: 'assistant', model: 'mock-reformulator', content: [{ type: 'text', text: JSON.stringify({ abstain: true, reason: 'insufficient_signal' }) }] } as never;
      }
      return {
        role: 'assistant',
        model: 'mock-reformulator',
        content: [{ type: 'text', text: JSON.stringify({ abstain: false, reason: 'query_rewritten', reformulated_query: input.reformulation.query }) }],
      } as never;
    }

    if (module === 'sem06b_discovery_reranker') {
      if (input.rerank.mode !== 'applied') {
        throw new Error('reranker_sampling_unavailable');
      }
      const ranked = (input.rerank.ranked_keys ?? []).map((canonical_key, index) => ({
        canonical_key,
        score: Math.max(0.1, 1 - index * 0.15),
        reason_codes: index === 0 ? ['reformulated_known_item_match'] : ['lower_confidence'],
      }));
      return {
        role: 'assistant',
        model: 'mock-reranker',
        content: [{ type: 'text', text: JSON.stringify({ abstain: false, reason: 'ranked_fixture', ranked }) }],
      } as never;
    }

    throw new Error(`unexpected_sampling_module:${module ?? 'missing'}`);
  };
}

function rankOf(keys: string[], target: string): number | null {
  const index = keys.indexOf(target);
  return index >= 0 ? index + 1 : null;
}

function probeKeys(actual: DiscoveryQueryReformulationArtifact): string[] {
  return actual.probe.top_stage1_canonical_keys;
}

export function judgeSem06d(expected: unknown, actual: Sem06dActual) {
  const exp = expected as Sem06dExpected;
  const providerHits = actual.provider_results.filter(result => result.result_count > 0).map(result => result.provider);
  const finalKeys = actual.papers.map(paper => paper.canonical_key);
  const finalRank = rankOf(finalKeys, exp.gold_canonical_key);
  const probeRank = rankOf(probeKeys(actual.reformulation), exp.gold_canonical_key);
  const triggerOk = actual.reformulation.qpp.trigger_decision === exp.expected_trigger_decision;
  const qppOk = actual.reformulation.qpp.status === exp.expected_qpp_status;
  const reformulationOk = actual.reformulation.reformulation.status === exp.expected_reformulation_status;
  const effectiveOk = actual.reformulation.effective_query === exp.expected_effective_query;
  const statusOk = actual.rerank.status === exp.expected_rerank_status;
  const providersOk = JSON.stringify(providerHits) === JSON.stringify(exp.provider_hit_providers);
  const canonicalOk = actual.papers.length === exp.canonical_count;
  const finalOk = finalRank !== null && finalRank <= exp.max_final_rank;
  const probeOk = exp.min_probe_rank === undefined || (probeRank !== null && probeRank >= exp.min_probe_rank);
  const samplingOk = actual.reformulation.telemetry.sampling_calls === exp.expected_sampling_calls;
  return {
    passed: triggerOk && qppOk && reformulationOk && effectiveOk && statusOk && providersOk && canonicalOk && finalOk && probeOk && samplingOk,
    metrics: {
      trigger_correct: triggerOk ? 1 : 0,
      no_trigger_correct: exp.expected_trigger_decision === 'not_triggered' && triggerOk ? 1 : 0,
      recall_at_3: recallAtK([finalRank], 3),
      mrr_at_10: mrrAtK([finalRank], 10),
      ndcg_at_10: ndcgAtK(finalKeys.map(key => (key === exp.gold_canonical_key ? 1 : 0)), 10),
      useful_trigger: exp.expected_trigger_decision === 'triggered' && probeRank !== null && finalRank !== null && finalRank < probeRank ? 1 : 0,
      failure_path_guard: qppOk && reformulationOk && statusOk ? 1 : 0,
      sampling_calls: actual.reformulation.telemetry.sampling_calls,
      effective_sampling_calls: actual.reformulation.telemetry.reformulation_count,
      cost_efficiency: 1 / (1 + actual.reformulation.telemetry.reformulation_count),
    },
  };
}

export function aggregateSem06d(results: Array<EvalResult<Sem06dActual>>) {
  const hard = results.filter(result => result.tags.includes('hard_query'));
  const easy = results.filter(result => result.tags.includes('easy_query'));
  const exact = results.filter(result => result.tags.includes('exact_id'));
  const usefulTriggerEligible = results.filter(result => {
    const expected = result.expected as Sem06dExpected;
    return expected.expected_trigger_decision === 'triggered' && expected.expected_reformulation_status === 'applied';
  });
  const failure = results.filter(result => result.tags.includes('failure_path'));
  return {
    hard_query_recall_at_3: avg(hard, 'recall_at_3'),
    hard_query_mrr_at_10: avg(hard, 'mrr_at_10'),
    hard_query_ndcg_at_10: avg(hard, 'ndcg_at_10'),
    easy_query_no_trigger_rate: avg(easy, 'no_trigger_correct'),
    exact_id_no_trigger_rate: avg(exact, 'no_trigger_correct'),
    trigger_decision_accuracy: avg(results, 'trigger_correct'),
    useful_trigger_rate: avg(usefulTriggerEligible, 'useful_trigger'),
    failure_path_guard_overall: avg(failure, 'failure_path_guard'),
    avg_sampling_calls_per_query: avg(results, 'effective_sampling_calls'),
    cost_efficiency_overall: avg(results, 'cost_efficiency'),
  };
}
