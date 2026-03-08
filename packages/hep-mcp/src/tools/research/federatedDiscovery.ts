import type { CreateMessageRequestParamsBase, CreateMessageResult } from '@modelcontextprotocol/sdk/types.js';
import {
  DiscoveryCanonicalPapersArtifactSchema,
  DiscoveryQueryReformulationArtifactSchema,
  DiscoverySearchLogEntrySchema,
  appendDiscoverySearchLogEntries,
  normalizeDiscoveryQuery,
  planDiscoveryProviders,
  type DiscoveryCapabilityName,
  type DiscoveryPlan,
  type DiscoveryQppAssessment,
  type DiscoveryQueryIntent,
  type DiscoveryQueryProbe,
  type DiscoveryQueryReformulationArtifact,
  type DiscoveryRerankArtifact,
  type DiscoverySearchLogEntry,
} from '@autoresearch/shared';
import { DISCOVERY_PROVIDER_DESCRIPTORS } from './discovery/providerDescriptors.js';
import { artifactRefs, discoveryDir, readSearchLogEntries, writeJsonArtifact, writeSearchLog, type DiscoveryArtifactRefs } from './discovery/storage.js';
import { buildDiscoveryQueryProbe, defaultAssessDiscoveryQuery } from './discovery/queryAssessment.js';
import { executeDiscoveryRound, type DiscoveryProviderExecutors, type DiscoveryProviderResult } from './discovery/queryExecution.js';
import { prerankCanonicalPapers, rerankCanonicalPapers } from './discovery/paperReranker.js';
import { runDiscoveryQueryReformulation } from './discovery/queryReformulator.js';

export type { DiscoveryProviderExecutor, DiscoveryProviderExecutors, DiscoveryProviderResult } from './discovery/queryExecution.js';
export type DiscoveryQppAssessor = (params: { query: string; intent: DiscoveryQueryIntent; probe: DiscoveryQueryProbe }) => DiscoveryQppAssessment;
type SamplingFn = (params: CreateMessageRequestParamsBase) => Promise<CreateMessageResult>;

export type RunFederatedDiscoveryParams = {
  query: string;
  intent: DiscoveryQueryIntent;
  preferred_providers?: Array<DiscoveryPlan['selected_providers'][number]>;
  required_capabilities?: DiscoveryCapabilityName[];
  limit: number;
  executors?: Partial<DiscoveryProviderExecutors>;
  createMessage?: SamplingFn;
  assessQuery?: DiscoveryQppAssessor;
  maxReformulationSamplingCalls?: number;
};

export type FederatedDiscoveryResult = {
  query_plan: DiscoveryPlan;
  reformulation: DiscoveryQueryReformulationArtifact;
  provider_results: DiscoveryProviderResult[];
  candidate_generation: Awaited<ReturnType<typeof executeDiscoveryRound>>['candidate_generation'];
  papers: Awaited<ReturnType<typeof rerankCanonicalPapers>>['papers'];
  dedup: Awaited<ReturnType<typeof executeDiscoveryRound>>['dedup'];
  rerank: DiscoveryRerankArtifact;
  artifacts: DiscoveryArtifactRefs;
};

function buildReformulationArtifact(query: string, effectiveQuery: string, qpp: DiscoveryQppAssessment, probe: DiscoveryQueryProbe, reformulation: Awaited<ReturnType<typeof runDiscoveryQueryReformulation>>['reformulation'], telemetry: Awaited<ReturnType<typeof runDiscoveryQueryReformulation>>['telemetry']): DiscoveryQueryReformulationArtifact {
  return DiscoveryQueryReformulationArtifactSchema.parse({
    version: 1,
    original_query: query,
    effective_query: effectiveQuery,
    normalized_effective_query: normalizeDiscoveryQuery(effectiveQuery),
    qpp,
    probe,
    reformulation,
    telemetry,
  });
}

function normalizeAssessorResult(qpp: unknown): DiscoveryQppAssessment {
  if (qpp && typeof qpp === 'object' && 'status' in qpp) {
    const typed = qpp as DiscoveryQppAssessment;
    if (typed.status === 'applied' || typed.status === 'unavailable' || typed.status === 'invalid') return typed;
  }
  return { status: 'invalid', difficulty: 'medium', ambiguity: 'medium', low_recall_risk: 'medium', trigger_decision: 'not_triggered', reason_codes: ['qpp_invalid'] };
}

export async function runFederatedDiscovery(params: RunFederatedDiscoveryParams): Promise<FederatedDiscoveryResult> {
  const query_plan = planDiscoveryProviders({ query: params.query, intent: params.intent, preferred_providers: params.preferred_providers ?? [], required_capabilities: params.required_capabilities ?? [], limit: params.limit }, DISCOVERY_PROVIDER_DESCRIPTORS);
  const probeRound = await executeDiscoveryRound({ plan: query_plan, query: params.query, intent: params.intent, limit: params.limit, executors: params.executors });
  const probePrerank = prerankCanonicalPapers(params.query, probeRound.papers);
  const probe = buildDiscoveryQueryProbe({
    query: params.query,
    candidateGeneration: probeRound.candidate_generation,
    papers: probeRound.papers,
    preranked: probePrerank.map(item => ({ canonical_key: item.paper.canonical_key, score: item.stage1_score, stage1_score: item.stage1_score, reason_codes: ['stage1_prerank'], provider_sources: item.paper.provider_sources, merge_state: item.paper.merge_state })),
  });

  let qpp: DiscoveryQppAssessment;
  try {
    qpp = normalizeAssessorResult(params.assessQuery ? params.assessQuery({ query: params.query, intent: params.intent, probe }) : defaultAssessDiscoveryQuery({ query: params.query, probe }));
  } catch {
    qpp = { status: 'unavailable', difficulty: 'medium', ambiguity: 'medium', low_recall_risk: 'medium', trigger_decision: 'not_triggered', reason_codes: ['qpp_unavailable'] };
  }

  const reformulationRun = await runDiscoveryQueryReformulation({ query: params.query, qpp, createMessage: params.createMessage, maxSamplingCalls: params.maxReformulationSamplingCalls ?? 1 });
  const executionRound = reformulationRun.reformulation.status === 'applied'
    ? await executeDiscoveryRound({ plan: query_plan, query: reformulationRun.effective_query, intent: params.intent, limit: params.limit, executors: params.executors })
    : probeRound;
  const reranked = await rerankCanonicalPapers({ query: reformulationRun.effective_query, papers: executionRound.papers, limit: params.limit, createMessage: params.createMessage });
  const reformulation = buildReformulationArtifact(params.query, reformulationRun.effective_query, qpp, probe, reformulationRun.reformulation, reformulationRun.telemetry);

  const dir = discoveryDir();
  const existingEntries = readSearchLogEntries(artifactRefs(dir, 1).search_log.file_path);
  const requestIndex = existingEntries.length + 1;
  const artifacts = artifactRefs(dir, requestIndex);
  writeJsonArtifact(artifacts.query_plan.file_path, query_plan);
  writeJsonArtifact(artifacts.reformulation.file_path, reformulation);
  writeJsonArtifact(artifacts.candidate_generation.file_path, executionRound.candidate_generation);
  writeJsonArtifact(artifacts.canonical_papers.file_path, DiscoveryCanonicalPapersArtifactSchema.parse({ version: 1, query: reformulationRun.effective_query, papers: reranked.papers }));
  writeJsonArtifact(artifacts.dedup.file_path, executionRound.dedup);
  writeJsonArtifact(artifacts.rerank.file_path, reranked.artifact);

  const entry = DiscoverySearchLogEntrySchema.parse({
    version: 1,
    request_index: requestIndex,
    logged_at: new Date().toISOString(),
    query: params.query,
    normalized_query: query_plan.normalized_query,
    effective_query: reformulation.effective_query,
    intent: params.intent,
    selected_providers: query_plan.selected_providers,
    provider_result_counts: {
      inspire: executionRound.provider_results.find(result => result.provider === 'inspire')?.result_count ?? 0,
      openalex: executionRound.provider_results.find(result => result.provider === 'openalex')?.result_count ?? 0,
      arxiv: executionRound.provider_results.find(result => result.provider === 'arxiv')?.result_count ?? 0,
    },
    canonical_paper_count: reranked.papers.length,
    uncertain_group_count: executionRound.dedup.uncertain_groups.length,
    qpp_status: reformulation.qpp.status,
    trigger_decision: reformulation.qpp.trigger_decision,
    reformulation_status: reformulation.reformulation.status,
    reformulation_sampling_calls: reformulation.telemetry.sampling_calls,
    reformulation_count: reformulation.telemetry.reformulation_count,
    artifact_locators: Object.values(artifacts),
  });
  const appendedEntries: DiscoverySearchLogEntry[] = appendDiscoverySearchLogEntries(existingEntries, entry);
  writeSearchLog(artifacts.search_log.file_path, appendedEntries);

  return {
    query_plan,
    reformulation,
    provider_results: executionRound.provider_results,
    candidate_generation: executionRound.candidate_generation,
    papers: reranked.papers,
    dedup: executionRound.dedup,
    rerank: reranked.artifact,
    artifacts,
  };
}
