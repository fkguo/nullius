import {
  ARXIV_GET_METADATA,
  ARXIV_SEARCH,
  DiscoveryCandidateBatchSchema,
  OPENALEX_GET,
  OPENALEX_SEARCH,
  OPENALEX_SEMANTIC_SEARCH,
  type DiscoveryCandidateBatch,
  type DiscoveryPlan,
  invalidParams,
  type PaperSummary,
} from '@autoresearch/shared';
import { getToolSpec as getArxivToolSpec } from '@autoresearch/arxiv-mcp/tooling';
import { getToolSpecs as getOpenAlexToolSpecs } from '@autoresearch/openalex-mcp/tooling';
import { getByArxiv, getByDoi, getPaper, search } from '../../../api/client.js';
import { fromArxivMetadata, fromOpenAlexWork, fromPaperSummary } from './candidateAdapters.js';
import { extractQueryIdentifiers, hasStructuredIdentifier } from './queryIdentifiers.js';

const openAlexTools = new Map(getOpenAlexToolSpecs('standard').map(spec => [spec.name, spec]));
const openAlexSelect = 'id,doi,title,publication_year,cited_by_count,authorships,ids';

function makeBatch(batch: DiscoveryCandidateBatch): DiscoveryCandidateBatch {
  return DiscoveryCandidateBatchSchema.parse(batch);
}

function skippedBatch(provider: DiscoveryCandidateBatch['provider'], channel: DiscoveryCandidateBatch['channel'], reason: string): DiscoveryCandidateBatch {
  return makeBatch({ provider, channel, executed: false, reason, result_count: 0, candidates: [] });
}

async function runInspire(plan: DiscoveryPlan, limit: number): Promise<DiscoveryCandidateBatch[]> {
  const ids = extractQueryIdentifiers(plan.query);
  const batches: DiscoveryCandidateBatch[] = [];
  if (ids.doi || ids.arxiv_id || ids.recid) {
    const paper = ids.recid ? await getPaper(ids.recid) : ids.doi ? await getByDoi(ids.doi) : await getByArxiv(ids.arxiv_id!);
    batches.push(makeBatch({
      provider: 'inspire',
      channel: 'identifier_lookup',
      executed: true,
      reason: 'exact_identifier_lookup',
      result_count: 1,
      candidates: [fromPaperSummary('inspire', paper as PaperSummary, 'identifier_lookup', plan.query, 0)],
    }));
  } else {
    batches.push(skippedBatch('inspire', 'identifier_lookup', 'no_supported_identifier_detected'));
  }

  const keyword = await search(plan.normalized_query, { size: limit });
  batches.push(makeBatch({
    provider: 'inspire',
    channel: 'keyword_search',
    executed: true,
    reason: 'provider_keyword_search',
    result_count: keyword.papers.length,
    candidates: keyword.papers.slice(0, limit).map((paper, index) => fromPaperSummary('inspire', paper, 'keyword_search', plan.query, index)),
  }));
  batches.push(skippedBatch('inspire', 'semantic_search', 'provider_semantic_search_not_available'));
  return batches;
}

async function runOpenAlex(plan: DiscoveryPlan, limit: number): Promise<DiscoveryCandidateBatch[]> {
  const ids = extractQueryIdentifiers(plan.query);
  const batches: DiscoveryCandidateBatch[] = [];
  const getTool = openAlexTools.get(OPENALEX_GET);
  const searchTool = openAlexTools.get(OPENALEX_SEARCH);
  const semanticTool = openAlexTools.get(OPENALEX_SEMANTIC_SEARCH);
  if (!getTool || !searchTool || !semanticTool) {
    throw invalidParams('Missing OpenAlex tool handlers in tooling export');
  }

  if (ids.openalex_id || ids.doi) {
    const result = await getTool.handler({ id: ids.openalex_id ?? ids.doi!, entity: 'works', select: openAlexSelect } as never) as { result?: Record<string, unknown> };
    const candidate = result.result ? fromOpenAlexWork(result.result, 'identifier_lookup', plan.query, 0) : null;
    batches.push(makeBatch({
      provider: 'openalex',
      channel: 'identifier_lookup',
      executed: true,
      reason: 'exact_identifier_lookup',
      result_count: candidate ? 1 : 0,
      candidates: candidate ? [candidate] : [],
    }));
  } else {
    batches.push(skippedBatch('openalex', 'identifier_lookup', 'no_supported_identifier_detected'));
  }

  const keyword = await searchTool.handler({ query: plan.query, page: 1, per_page: limit, select: openAlexSelect } as never) as { results?: Array<Record<string, unknown>> };
  const keywordCandidates = (keyword.results ?? []).map((work, index) => fromOpenAlexWork(work, 'keyword_search', plan.query, index)).filter((candidate): candidate is NonNullable<typeof candidate> => Boolean(candidate));
  batches.push(makeBatch({
    provider: 'openalex',
    channel: 'keyword_search',
    executed: true,
    reason: 'provider_keyword_search',
    result_count: keywordCandidates.length,
    candidates: keywordCandidates,
  }));

  if (hasStructuredIdentifier(ids)) {
    batches.push(skippedBatch('openalex', 'semantic_search', 'structured_identifier_query_prefers_exact_lookup'));
  } else if (!process.env.OPENALEX_API_KEY) {
    batches.push(skippedBatch('openalex', 'semantic_search', 'openalex_api_key_missing'));
  } else {
    const semantic = await semanticTool.handler({ query: plan.query, page: 1, per_page: limit, select: openAlexSelect } as never) as { results?: Array<Record<string, unknown>> };
    const semanticCandidates = (semantic.results ?? []).map((work, index) => fromOpenAlexWork(work, 'semantic_search', plan.query, index)).filter((candidate): candidate is NonNullable<typeof candidate> => Boolean(candidate));
    batches.push(makeBatch({
      provider: 'openalex',
      channel: 'semantic_search',
      executed: true,
      reason: 'provider_native_semantic_search',
      result_count: semanticCandidates.length,
      candidates: semanticCandidates,
    }));
  }

  return batches;
}

async function runArxiv(plan: DiscoveryPlan, limit: number): Promise<DiscoveryCandidateBatch[]> {
  const ids = extractQueryIdentifiers(plan.query);
  const batches: DiscoveryCandidateBatch[] = [];
  const getTool = getArxivToolSpec(ARXIV_GET_METADATA);
  const searchTool = getArxivToolSpec(ARXIV_SEARCH);
  if (!getTool || !searchTool) {
    throw invalidParams('Missing arXiv tool handlers in tooling export');
  }

  if (ids.arxiv_id) {
    const metadata = await getTool.handler({ arxiv_id: ids.arxiv_id } as never, {}) as import('@autoresearch/arxiv-mcp/tooling').ArxivMetadata;
    batches.push(makeBatch({
      provider: 'arxiv',
      channel: 'identifier_lookup',
      executed: true,
      reason: 'exact_identifier_lookup',
      result_count: 1,
      candidates: [fromArxivMetadata(metadata, 'identifier_lookup', plan.query, 0)],
    }));
  } else {
    batches.push(skippedBatch('arxiv', 'identifier_lookup', 'no_supported_identifier_detected'));
  }

  const keyword = await searchTool.handler({ query: plan.normalized_query, max_results: limit, start: 0, sort_by: 'relevance' } as never, {}) as { entries?: import('@autoresearch/arxiv-mcp/tooling').ArxivMetadata[] };
  batches.push(makeBatch({
    provider: 'arxiv',
    channel: 'keyword_search',
    executed: true,
    reason: 'provider_keyword_search',
    result_count: keyword.entries?.length ?? 0,
    candidates: (keyword.entries ?? []).map((entry, index) => fromArxivMetadata(entry, 'keyword_search', plan.query, index)),
  }));
  batches.push(skippedBatch('arxiv', 'semantic_search', 'provider_semantic_search_not_available'));
  return batches;
}

export async function runHybridCandidateGeneration(plan: DiscoveryPlan, limit: number): Promise<DiscoveryCandidateBatch[]> {
  const batches: DiscoveryCandidateBatch[] = [];
  for (const provider of plan.selected_providers) {
    try {
      if (provider === 'inspire') batches.push(...await runInspire(plan, limit));
      else if (provider === 'openalex') batches.push(...await runOpenAlex(plan, limit));
      else if (provider === 'arxiv') batches.push(...await runArxiv(plan, limit));
    } catch (error) {
      batches.push(skippedBatch(provider, 'keyword_search', error instanceof Error ? error.message : String(error)));
    }
  }
  return batches;
}
