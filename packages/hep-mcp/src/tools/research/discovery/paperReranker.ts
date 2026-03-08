import type { CreateMessageRequestParamsBase, CreateMessageResult } from '@modelcontextprotocol/sdk/types.js';
import {
  DiscoveryRerankArtifactSchema,
  normalizeDiscoveryTitle,
  type CanonicalPaper,
  type DiscoveryRerankedPaper,
  type DiscoveryRerankArtifact,
} from '@autoresearch/shared';
import { buildToolSamplingMetadata } from '../../../core/sampling-metadata.js';
import { clamp01, extractSamplingText } from '../../../core/semantics/quantitySampling.js';
import { buildPaperRerankerPrompt } from './paperRerankerPrompt.js';

type SamplingFn = (params: CreateMessageRequestParamsBase) => Promise<CreateMessageResult>;

type RankedResponse = {
  abstain: boolean;
  reason: string;
  ranked: Array<{ canonical_key: string; score: number; reason_codes?: string[] }>;
};

function tokenize(input: string): string[] {
  return normalizeDiscoveryTitle(input).split(' ').filter(Boolean);
}

function hasExactIdentifierMatch(query: string, paper: CanonicalPaper): boolean {
  const raw = query.toLowerCase();
  return Object.values(paper.identifiers).some(value => typeof value === 'string' && raw.includes(value.toLowerCase()));
}

function stage1Score(query: string, paper: CanonicalPaper, maxCitation: number): number {
  const queryTokens = new Set(tokenize(query));
  const titleTokens = tokenize(paper.title);
  const overlap = titleTokens.length === 0 ? 0 : titleTokens.filter(token => queryTokens.has(token)).length / titleTokens.length;
  const exact = hasExactIdentifierMatch(query, paper) ? 1 : 0;
  const providerAgreement = Math.min(1, paper.provider_sources.length / 3);
  const citation = maxCitation > 0 ? (paper.citation_count ?? 0) / maxCitation : 0;
  const semanticHints = paper.match_reasons.some(reason => reason.startsWith('exact_')) ? 1 : paper.match_reasons.length > 0 ? 0.6 : 0.2;
  return clamp01(0.5 * exact + 0.2 * overlap + 0.15 * providerAgreement + 0.1 * semanticHints + 0.05 * citation);
}

function parseRerankResponse(input: string): RankedResponse | null {
  if (!input.trim()) return null;
  try {
    const parsed = JSON.parse(input) as RankedResponse;
    if (!Array.isArray(parsed.ranked) || typeof parsed.abstain !== 'boolean' || typeof parsed.reason !== 'string') return null;
    if (parsed.ranked.some(item => !item || typeof item.canonical_key !== 'string' || !Number.isFinite(item.score))) return null;
    return parsed;
  } catch {
    return null;
  }
}

export async function rerankCanonicalPapers(params: {
  query: string;
  papers: CanonicalPaper[];
  limit: number;
  createMessage?: SamplingFn;
}): Promise<{ papers: CanonicalPaper[]; artifact: DiscoveryRerankArtifact }> {
  const maxCitation = Math.max(1, ...params.papers.map(paper => paper.citation_count ?? 0));
  const preranked = params.papers
    .map(paper => ({ paper, stage1_score: stage1Score(params.query, paper, maxCitation) }))
    .sort((left, right) => right.stage1_score - left.stage1_score || left.paper.canonical_key.localeCompare(right.paper.canonical_key));
  const candidateCountOut = Math.min(params.limit, preranked.length);
  const topK = Math.min(5, preranked.length);

  const fallbackRanked: DiscoveryRerankedPaper[] = preranked.map(({ paper, stage1_score }) => ({
    canonical_key: paper.canonical_key,
    score: stage1_score,
    stage1_score,
    reason_codes: ['stage1_prerank'],
    provider_sources: paper.provider_sources,
    merge_state: paper.merge_state,
  }));

  if (topK < 2) {
    const artifact = DiscoveryRerankArtifactSchema.parse({
      version: 1,
      query: params.query,
      status: 'insufficient_candidates',
      reranker: { name: 'canonical_paper_reranker', method: 'hybrid_feature_prerank', top_k: topK || 1, candidate_count_in: preranked.length, candidate_count_out: candidateCountOut, reason: 'insufficient_candidates' },
      ranked_papers: fallbackRanked,
    });
    return { papers: preranked.map(item => item.paper), artifact };
  }

  if (!params.createMessage) {
    const artifact = DiscoveryRerankArtifactSchema.parse({
      version: 1,
      query: params.query,
      status: 'unavailable',
      reranker: { name: 'canonical_paper_reranker', method: 'llm_listwise_rerank', top_k: topK, candidate_count_in: preranked.length, candidate_count_out: candidateCountOut, reason: 'sampling_unavailable' },
      ranked_papers: fallbackRanked,
    });
    return { papers: preranked.map(item => item.paper), artifact };
  }

  try {
    const response = await params.createMessage({
      messages: [{ role: 'user', content: { type: 'text', text: buildPaperRerankerPrompt({ promptVersion: 'new-sem06b-r1', query: params.query, papers: preranked.slice(0, topK).map(item => ({ ...item.paper, stage1_score: item.stage1_score })) }) } }],
      maxTokens: 900,
      metadata: buildToolSamplingMetadata({ tool: 'federated_discovery', module: 'sem06b_discovery_reranker', promptVersion: 'new-sem06b-r1', costClass: 'medium', context: { candidate_count: topK, query_length: params.query.length } }),
    });
    const parsed = parseRerankResponse(extractSamplingText(response.content));
    if (!parsed || parsed.abstain) throw new Error(parsed?.reason ?? 'invalid_response');

    const rerankedTop = new Map(parsed.ranked.map(item => [item.canonical_key, item]));
    const ranked = preranked.map(({ paper, stage1_score }) => {
      const item = rerankedTop.get(paper.canonical_key);
      const finalScore = item ? clamp01(0.75 * clamp01(item.score) + 0.25 * stage1_score) : stage1_score;
      return {
        paper,
        ranked: {
          canonical_key: paper.canonical_key,
          score: finalScore,
          stage1_score,
          reason_codes: item?.reason_codes?.length ? item.reason_codes : ['stage1_prerank'],
          provider_sources: paper.provider_sources,
          merge_state: paper.merge_state,
        },
      };
    }).sort((left, right) => right.ranked.score - left.ranked.score || left.paper.canonical_key.localeCompare(right.paper.canonical_key));

    const artifact = DiscoveryRerankArtifactSchema.parse({
      version: 1,
      query: params.query,
      status: 'applied',
      reranker: { name: 'canonical_paper_reranker', method: 'llm_listwise_rerank', top_k: topK, candidate_count_in: preranked.length, candidate_count_out: candidateCountOut, model: response.model },
      ranked_papers: ranked.map(item => item.ranked),
    });
    return { papers: ranked.map(item => item.paper), artifact };
  } catch (error) {
    const artifact = DiscoveryRerankArtifactSchema.parse({
      version: 1,
      query: params.query,
      status: 'unavailable',
      reranker: { name: 'canonical_paper_reranker', method: 'llm_listwise_rerank', top_k: topK, candidate_count_in: preranked.length, candidate_count_out: candidateCountOut, reason: error instanceof Error ? error.message : String(error) },
      ranked_papers: fallbackRanked,
    });
    return { papers: preranked.map(item => item.paper), artifact };
  }
}
