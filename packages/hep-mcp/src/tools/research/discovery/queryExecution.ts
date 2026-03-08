import {
  DiscoveryCandidateGenerationArtifactSchema,
  canonicalizeDiscoveryCandidates,
  invalidParams,
  normalizeDiscoveryQuery,
  type CanonicalCandidate,
  type CanonicalPaper,
  type DiscoveryCandidateGenerationArtifact,
  type DiscoveryDedupArtifact,
  type DiscoveryPlan,
  type DiscoveryProviderId,
  type DiscoveryQueryIntent,
} from '@autoresearch/shared';

export type DiscoveryProviderResult = {
  provider: DiscoveryProviderId;
  query: string;
  candidates: CanonicalCandidate[];
  result_count: number;
};

export type DiscoveryProviderExecutor = (request: {
  provider: DiscoveryProviderId;
  query: string;
  normalized_query: string;
  intent: DiscoveryQueryIntent;
  limit: number;
}) => Promise<DiscoveryProviderResult>;

export type DiscoveryProviderExecutors = Record<DiscoveryProviderId, DiscoveryProviderExecutor>;

function aggregateProviderResults(batches: DiscoveryCandidateGenerationArtifact['batches']): DiscoveryProviderResult[] {
  const providers: DiscoveryProviderId[] = ['inspire', 'openalex', 'arxiv'];
  return providers.flatMap(provider => {
    const matched = batches.filter(batch => batch.provider === provider && batch.executed);
    if (matched.length === 0) return [];
    return [{
      provider,
      query: matched[0]?.candidates[0]?.provenance.query ?? '',
      candidates: matched.flatMap(batch => batch.candidates),
      result_count: matched.reduce((sum, batch) => sum + batch.result_count, 0),
    }];
  });
}

async function overrideCandidateGeneration(params: {
  plan: DiscoveryPlan;
  query: string;
  intent: DiscoveryQueryIntent;
  limit: number;
  executors: Partial<DiscoveryProviderExecutors>;
}): Promise<DiscoveryCandidateGenerationArtifact> {
  const normalizedQuery = normalizeDiscoveryQuery(params.query);
  const batches = [] as DiscoveryCandidateGenerationArtifact['batches'];
  for (const provider of params.plan.selected_providers) {
    const executor = params.executors[provider];
    if (!executor) {
      throw invalidParams(`Missing discovery executor for provider: ${provider}`, { provider, selected_providers: params.plan.selected_providers });
    }
    const result = await executor({ provider, query: params.query, normalized_query: normalizedQuery, intent: params.intent, limit: params.limit });
    batches.push({ provider, channel: 'override', executed: true, reason: 'test_override_executor', result_count: result.result_count, candidates: result.candidates.slice(0, params.limit) });
  }
  return DiscoveryCandidateGenerationArtifactSchema.parse({ version: 1, query: params.query, normalized_query: normalizedQuery, intent: params.intent, batches });
}

async function runProviderBackbone(plan: DiscoveryPlan, limit: number) {
  const { runHybridCandidateGeneration } = await import('./providerExecutors.js');
  return runHybridCandidateGeneration(plan, limit);
}

export async function executeDiscoveryRound(params: {
  plan: DiscoveryPlan;
  query: string;
  intent: DiscoveryQueryIntent;
  limit: number;
  executors?: Partial<DiscoveryProviderExecutors>;
}): Promise<{
  candidate_generation: DiscoveryCandidateGenerationArtifact;
  provider_results: DiscoveryProviderResult[];
  papers: CanonicalPaper[];
  dedup: DiscoveryDedupArtifact;
}> {
  const executionPlan: DiscoveryPlan = { ...params.plan, query: params.query, normalized_query: normalizeDiscoveryQuery(params.query) };
  const candidate_generation = params.executors
    ? await overrideCandidateGeneration({ ...params, plan: executionPlan, executors: params.executors })
    : DiscoveryCandidateGenerationArtifactSchema.parse({
      version: 1,
      query: params.query,
      normalized_query: executionPlan.normalized_query,
      intent: params.intent,
      batches: await runProviderBackbone(executionPlan, params.limit),
    });
  const provider_results = aggregateProviderResults(candidate_generation.batches);
  const { papers, dedup } = canonicalizeDiscoveryCandidates({ query: params.query, candidates: candidate_generation.batches.flatMap(batch => batch.candidates) });
  return { candidate_generation, provider_results, papers, dedup };
}
