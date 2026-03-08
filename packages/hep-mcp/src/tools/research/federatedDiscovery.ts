import type { CreateMessageRequestParamsBase, CreateMessageResult } from '@modelcontextprotocol/sdk/types.js';
import {
  DiscoveryCandidateGenerationArtifactSchema,
  DiscoveryCanonicalPapersArtifactSchema,
  DiscoverySearchLogEntrySchema,
  appendDiscoverySearchLogEntries,
  canonicalizeDiscoveryCandidates,
  invalidParams,
  normalizeDiscoveryQuery,
  planDiscoveryProviders,
  type CanonicalCandidate,
  type CanonicalPaper,
  type DiscoveryCandidateGenerationArtifact,
  type DiscoveryCapabilityName,
  type DiscoveryDedupArtifact,
  type DiscoveryPlan,
  type DiscoveryProviderId,
  type DiscoveryQueryIntent,
  type DiscoveryRerankArtifact,
  type DiscoverySearchLogEntry,
} from '@autoresearch/shared';
import { DISCOVERY_PROVIDER_DESCRIPTORS } from '../registry/shared.js';
import {
  artifactRefs,
  discoveryDir,
  readSearchLogEntries,
  writeJsonArtifact,
  writeSearchLog,
  type DiscoveryArtifactRefs,
} from './discovery/storage.js';
import { rerankCanonicalPapers } from './discovery/paperReranker.js';
import { runHybridCandidateGeneration } from './discovery/providerExecutors.js';

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

type SamplingFn = (params: CreateMessageRequestParamsBase) => Promise<CreateMessageResult>;

export type RunFederatedDiscoveryParams = {
  query: string;
  intent: DiscoveryQueryIntent;
  preferred_providers?: DiscoveryProviderId[];
  required_capabilities?: DiscoveryCapabilityName[];
  limit: number;
  executors?: Partial<DiscoveryProviderExecutors>;
  createMessage?: SamplingFn;
};

export type FederatedDiscoveryResult = {
  query_plan: DiscoveryPlan;
  provider_results: DiscoveryProviderResult[];
  candidate_generation: DiscoveryCandidateGenerationArtifact;
  papers: CanonicalPaper[];
  dedup: DiscoveryDedupArtifact;
  rerank: DiscoveryRerankArtifact;
  artifacts: DiscoveryArtifactRefs;
};

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

async function overrideCandidateGeneration(
  queryPlan: DiscoveryPlan,
  params: Pick<RunFederatedDiscoveryParams, 'query' | 'intent' | 'limit' | 'executors'>,
): Promise<DiscoveryCandidateGenerationArtifact> {
  const normalizedQuery = normalizeDiscoveryQuery(params.query);
  const batches = [] as DiscoveryCandidateGenerationArtifact['batches'];
  for (const provider of queryPlan.selected_providers) {
    const executor = params.executors?.[provider];
    if (!executor) {
      throw invalidParams(`Missing discovery executor for provider: ${provider}`, { provider, selected_providers: queryPlan.selected_providers });
    }
    const result = await executor({ provider, query: params.query, normalized_query: normalizedQuery, intent: params.intent, limit: params.limit });
    batches.push({
      provider,
      channel: 'override',
      executed: true,
      reason: 'test_override_executor',
      result_count: result.result_count,
      candidates: result.candidates.slice(0, params.limit),
    });
  }
  return DiscoveryCandidateGenerationArtifactSchema.parse({
    version: 1,
    query: params.query,
    normalized_query: normalizedQuery,
    intent: params.intent,
    batches,
  });
}

export async function runFederatedDiscovery(params: RunFederatedDiscoveryParams): Promise<FederatedDiscoveryResult> {
  const normalized_query = normalizeDiscoveryQuery(params.query);
  const query_plan = planDiscoveryProviders({
    query: params.query,
    intent: params.intent,
    preferred_providers: params.preferred_providers ?? [],
    required_capabilities: params.required_capabilities ?? [],
    limit: params.limit,
  }, DISCOVERY_PROVIDER_DESCRIPTORS);

  const candidate_generation = params.executors
    ? await overrideCandidateGeneration(query_plan, params)
    : DiscoveryCandidateGenerationArtifactSchema.parse({
      version: 1,
      query: params.query,
      normalized_query,
      intent: params.intent,
      batches: await runHybridCandidateGeneration(query_plan, params.limit),
    });

  const provider_results = aggregateProviderResults(candidate_generation.batches);
  const { papers: canonicalPapers, dedup } = canonicalizeDiscoveryCandidates({
    query: params.query,
    candidates: candidate_generation.batches.flatMap(batch => batch.candidates),
  });
  const reranked = await rerankCanonicalPapers({
    query: params.query,
    papers: canonicalPapers,
    limit: params.limit,
    createMessage: params.createMessage,
  });

  const dir = discoveryDir();
  const existingEntries = readSearchLogEntries(artifactRefs(dir, 1).search_log.file_path);
  const requestIndex = existingEntries.length + 1;
  const artifacts = artifactRefs(dir, requestIndex);

  writeJsonArtifact(artifacts.query_plan.file_path, query_plan);
  writeJsonArtifact(artifacts.candidate_generation.file_path, candidate_generation);
  writeJsonArtifact(artifacts.canonical_papers.file_path, DiscoveryCanonicalPapersArtifactSchema.parse({ version: 1, query: params.query, papers: reranked.papers }));
  writeJsonArtifact(artifacts.dedup.file_path, dedup);
  writeJsonArtifact(artifacts.rerank.file_path, reranked.artifact);

  const entry = DiscoverySearchLogEntrySchema.parse({
    version: 1,
    request_index: requestIndex,
    logged_at: new Date().toISOString(),
    query: params.query,
    normalized_query,
    intent: params.intent,
    selected_providers: query_plan.selected_providers,
    provider_result_counts: {
      inspire: provider_results.find(result => result.provider === 'inspire')?.result_count ?? 0,
      openalex: provider_results.find(result => result.provider === 'openalex')?.result_count ?? 0,
      arxiv: provider_results.find(result => result.provider === 'arxiv')?.result_count ?? 0,
    },
    canonical_paper_count: reranked.papers.length,
    uncertain_group_count: dedup.uncertain_groups.length,
    artifact_locators: Object.values(artifacts),
  });

  const appendedEntries: DiscoverySearchLogEntry[] = appendDiscoverySearchLogEntries(existingEntries, entry);
  writeSearchLog(artifacts.search_log.file_path, appendedEntries);

  return {
    query_plan,
    provider_results,
    candidate_generation,
    papers: reranked.papers,
    dedup,
    rerank: reranked.artifact,
    artifacts,
  };
}
