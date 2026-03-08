import * as fs from 'fs';
import * as path from 'path';
import {
  DiscoveryCanonicalPapersArtifactSchema,
  DiscoverySearchLogEntrySchema,
  appendDiscoverySearchLogEntries,
  canonicalizeDiscoveryCandidates,
  normalizeDiscoveryQuery,
  planDiscoveryProviders,
  type CanonicalCandidate,
  type CanonicalPaper,
  type DiscoveryCapabilityName,
  type DiscoveryDedupArtifact,
  type DiscoveryPlan,
  type DiscoveryProviderId,
  type DiscoveryQueryIntent,
  type DiscoverySearchLogEntry,
} from '@autoresearch/shared';
import { atomicWriteFileSync } from '../../core/atomicWrite.js';
import { ensureDir, getCacheDir } from '../../data/dataDir.js';
import { DISCOVERY_PROVIDER_DESCRIPTORS } from '../registry/shared.js';

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

type DiscoveryArtifactRef = { artifact_name: string; file_path: string };

type RunFederatedDiscoveryParams = {
  query: string;
  intent: DiscoveryQueryIntent;
  preferred_providers?: DiscoveryProviderId[];
  required_capabilities?: DiscoveryCapabilityName[];
  limit: number;
  executors: DiscoveryProviderExecutors;
};

export type FederatedDiscoveryResult = {
  query_plan: DiscoveryPlan;
  provider_results: DiscoveryProviderResult[];
  papers: CanonicalPaper[];
  dedup: DiscoveryDedupArtifact;
  artifacts: {
    query_plan: DiscoveryArtifactRef;
    canonical_papers: DiscoveryArtifactRef;
    dedup: DiscoveryArtifactRef;
    search_log: DiscoveryArtifactRef;
  };
};

function padIndex(index: number): string {
  return String(index).padStart(3, '0');
}

function discoveryDir(): string {
  const dir = path.join(getCacheDir(), 'discovery');
  ensureDir(dir);
  return dir;
}

function searchLogPath(dir: string): string {
  return path.join(dir, 'discovery_search_log_v1.jsonl');
}

function readSearchLogEntries(filePath: string): DiscoverySearchLogEntry[] {
  if (!fs.existsSync(filePath)) return [];
  const text = fs.readFileSync(filePath, 'utf-8').trim();
  if (!text) return [];
  return text
    .split('\n')
    .filter(line => line.trim().length > 0)
    .map(line => DiscoverySearchLogEntrySchema.parse(JSON.parse(line) as unknown));
}

function writeJsonArtifact(filePath: string, payload: unknown): void {
  atomicWriteFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`);
}

function writeSearchLog(filePath: string, entries: DiscoverySearchLogEntry[]): void {
  atomicWriteFileSync(filePath, `${entries.map(entry => JSON.stringify(entry)).join('\n')}\n`);
}

function artifactRefs(dir: string, requestIndex: number): FederatedDiscoveryResult['artifacts'] {
  const suffix = padIndex(requestIndex);
  return {
    query_plan: {
      artifact_name: `discovery_query_plan_${suffix}_v1.json`,
      file_path: path.join(dir, `discovery_query_plan_${suffix}_v1.json`),
    },
    canonical_papers: {
      artifact_name: `discovery_canonical_papers_${suffix}_v1.json`,
      file_path: path.join(dir, `discovery_canonical_papers_${suffix}_v1.json`),
    },
    dedup: {
      artifact_name: `discovery_dedup_${suffix}_v1.json`,
      file_path: path.join(dir, `discovery_dedup_${suffix}_v1.json`),
    },
    search_log: {
      artifact_name: 'discovery_search_log_v1.jsonl',
      file_path: searchLogPath(dir),
    },
  };
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

  const provider_results: DiscoveryProviderResult[] = [];
  for (const provider of query_plan.selected_providers) {
    const executor = params.executors[provider];
    if (!executor) throw new Error(`Missing discovery executor for provider: ${provider}`);
    const result = await executor({ provider, query: params.query, normalized_query, intent: params.intent, limit: params.limit });
    provider_results.push({
      provider,
      query: result.query,
      candidates: result.candidates.slice(0, params.limit),
      result_count: result.result_count,
    });
  }

  const { papers, dedup } = canonicalizeDiscoveryCandidates({
    query: params.query,
    candidates: provider_results.flatMap(result => result.candidates),
  });

  const dir = discoveryDir();
  const existingEntries = readSearchLogEntries(searchLogPath(dir));
  const requestIndex = existingEntries.length + 1;
  const artifacts = artifactRefs(dir, requestIndex);

  writeJsonArtifact(artifacts.query_plan.file_path, query_plan);
  writeJsonArtifact(
    artifacts.canonical_papers.file_path,
    DiscoveryCanonicalPapersArtifactSchema.parse({ version: 1, query: params.query, papers }),
  );
  writeJsonArtifact(artifacts.dedup.file_path, dedup);

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
    canonical_paper_count: papers.length,
    uncertain_group_count: dedup.uncertain_groups.length,
    artifact_locators: Object.values(artifacts),
  });

  const appendedEntries = appendDiscoverySearchLogEntries(existingEntries, entry);
  writeSearchLog(artifacts.search_log.file_path, appendedEntries);

  return { query_plan, provider_results, papers, dedup, artifacts };
}
