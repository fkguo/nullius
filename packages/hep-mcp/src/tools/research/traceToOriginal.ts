import type {
  CreateMessageRequestParamsBase,
  CreateMessageResult,
} from '@modelcontextprotocol/sdk/types.js';
import { INSPIRE_TRACE_ORIGINAL_SOURCE, type PaperSummary } from '@autoresearch/shared';
import * as api from '../../api/client.js';
import { buildToolSamplingMetadata } from '../../core/sampling-metadata.js';
import { extractSamplingText } from '../../core/semantics/quantitySampling.js';
import { classifyPaper } from './paperClassifier.js';
import { classifyReviews } from './reviewClassifier.js';
import {
  buildProvenanceMatchingPrompt,
  parseProvenanceMatchingResponse,
} from './provenanceMatchingSampling.js';
import { sha256Hex, type SemanticAssessmentProvenance } from './semantic/semanticProvenance.js';

export interface TraceToOriginalParams {
  recid: string;
  min_similarity?: number;
  max_candidates?: number;
}

export type PaperRelationship = 'same_content' | 'extended' | 'preliminary' | 'unknown';
export type TraceMatchStatus = 'matched' | 'uncertain' | 'no_match' | 'input_not_traceable' | 'sampling_unavailable';

export interface TraceToOriginalResult {
  status: TraceMatchStatus;
  success: boolean;
  conference_paper: PaperSummary;
  original_paper: PaperSummary | null;
  relationship: PaperRelationship;
  confidence: number;
  reason?: string;
  provenance: SemanticAssessmentProvenance;
  candidate_count: number;
  candidate_diagnostics: Array<{ candidate_key: string; recid?: string; prior_signals: string[] }>;
}

type SamplingContext = {
  createMessage?: (params: CreateMessageRequestParamsBase) => Promise<CreateMessageResult>;
};

type Candidate = {
  candidate_key: string;
  paper: PaperSummary;
  prior_score: number;
  prior_signals: string[];
};

function extractFirstAuthorQuery(authors: string[]): string | null {
  if (!authors.length) return null;
  const first = authors[0];
  const comma = first.match(/^([^,]+),/);
  if (comma) return comma[1].trim();
  const parts = first.trim().split(/\s+/);
  return parts.length > 0 ? parts[parts.length - 1] : null;
}

function extractTitleKeywords(title: string): string[] {
  const stopWords = new Set(['the', 'a', 'an', 'of', 'in', 'on', 'for', 'to', 'and', 'or', 'with', 'from', 'by', 'at', 'as', 'new', 'study', 'analysis', 'results', 'measurement', 'measurements']);
  return title
    .toLowerCase()
    .replace(/[^\w\s-]/g, ' ')
    .split(/\s+/)
    .filter(word => word.length > 2 && !stopWords.has(word));
}

function normalizeSurnames(authors: string[]): Set<string> {
  return new Set(authors.map(author => {
    const comma = author.match(/^([^,]+),/);
    return comma ? comma[1].trim().toLowerCase() : author.trim().split(/\s+/).pop()?.toLowerCase() || '';
  }).filter(Boolean));
}

function authorOverlapRatio(left: string[], right: string[]): number {
  const a = normalizeSurnames(left);
  const b = normalizeSurnames(right);
  if (a.size === 0 || b.size === 0) return 0;
  const overlap = [...a].filter(value => b.has(value)).length;
  return overlap / Math.min(a.size, b.size);
}

function titleTokenOverlap(left: string, right: string): number {
  const a = new Set(extractTitleKeywords(left));
  const b = new Set(extractTitleKeywords(right));
  if (a.size === 0 || b.size === 0) return 0;
  const overlap = [...a].filter(value => b.has(value)).length;
  return overlap / Math.min(a.size, b.size);
}

function buildSearchQuery(paper: PaperSummary): string {
  const author = extractFirstAuthorQuery(paper.authors ?? []);
  const titleTokens = extractTitleKeywords(paper.title).slice(0, 5).join(' ');
  if (author && titleTokens) return `a:${author} and t:${titleTokens} not tc:r`;
  if (titleTokens) return `t:${titleTokens} not tc:r`;
  if (author) return `a:${author} not tc:r`;
  return paper.title;
}

function describeMetadataPrior(paper: PaperSummary): string {
  const classified = classifyPaper(paper);
  return `${classified.paper_type}:${classified.paper_type_provenance.reason_code}`;
}

function rankCandidates(input: PaperSummary, candidates: PaperSummary[], maxCandidates: number): Candidate[] {
  return candidates
    .filter(candidate => candidate.recid && candidate.recid !== input.recid)
    .map(candidate => {
      const overlap = authorOverlapRatio(input.authors ?? [], candidate.authors ?? []);
      const titleOverlap = titleTokenOverlap(input.title, candidate.title);
      const yearDelta = Math.abs((candidate.year ?? input.year ?? 0) - (input.year ?? candidate.year ?? 0));
      const priorSignals = [
        `author_overlap:${overlap.toFixed(2)}`,
        `title_overlap:${titleOverlap.toFixed(2)}`,
        `year_delta:${yearDelta}`,
        `candidate_type:${describeMetadataPrior(candidate)}`,
      ];
      const priorScore = overlap * 0.45 + titleOverlap * 0.35 + Math.max(0, 0.2 - Math.min(yearDelta, 10) / 50);
      return { candidate_key: candidate.recid || candidate.title, paper: candidate, prior_score: priorScore, prior_signals: priorSignals };
    })
    .sort((a, b) => b.prior_score - a.prior_score)
    .slice(0, maxCandidates);
}

function buildResult(params: {
  status: TraceMatchStatus;
  paper: PaperSummary;
  original_paper?: PaperSummary | null;
  relationship?: PaperRelationship;
  confidence?: number;
  reason?: string;
  provenance: SemanticAssessmentProvenance;
  candidate_count: number;
  candidate_diagnostics: Array<{ candidate_key: string; recid?: string; prior_signals: string[] }>;
}): TraceToOriginalResult {
  return {
    status: params.status,
    success: params.status === 'matched' && Boolean(params.original_paper),
    conference_paper: params.paper,
    original_paper: params.original_paper ?? null,
    relationship: params.relationship ?? 'unknown',
    confidence: params.confidence ?? 0,
    reason: params.reason,
    provenance: params.provenance,
    candidate_count: params.candidate_count,
    candidate_diagnostics: params.candidate_diagnostics,
  };
}

export async function traceToOriginal(
  params: TraceToOriginalParams,
  ctx: SamplingContext = {},
): Promise<TraceToOriginalResult> {
  const { recid, max_candidates = 5 } = params;
  const promptVersion = 'sem12_provenance_matcher_v1';
  const paper = await api.getPaper(recid);
  const classified = classifyPaper(paper);
  const reviewHint = ctx.createMessage ? await classifyReviews({ recids: [recid] }, { createMessage: ctx.createMessage }) : null;
  const firstReviewClassification = reviewHint?.classifications[0];
  const baseDiagnostics: Array<{ candidate_key: string; recid?: string; prior_signals: string[] }> = [];

  if (firstReviewClassification?.provenance.status === 'applied' && firstReviewClassification.review_type !== 'uncertain') {
    return buildResult({
      status: 'input_not_traceable',
      paper,
      reason: 'Input paper is semantically classified as a review/survey rather than a traceable preliminary record.',
      provenance: {
        backend: firstReviewClassification.provenance.backend,
        status: 'applied',
        authority: 'semantic_conclusion',
        reason_code: 'review_article_not_traceable',
        prompt_version: firstReviewClassification.provenance.prompt_version,
        input_hash: firstReviewClassification.provenance.input_hash,
        model: firstReviewClassification.provenance.model,
      },
      candidate_count: 0,
      candidate_diagnostics: baseDiagnostics,
    });
  }

  const searchQuery = buildSearchQuery(paper);
  const searchResult = await api.search(searchQuery, { sort: 'mostcited', size: 50 });
  if (!ctx.createMessage && searchResult.papers.some(candidate => candidate.recid && candidate.recid !== paper.recid)) {
    return buildResult({
      status: 'sampling_unavailable',
      paper,
      reason: 'Semantic provenance adjudication requires MCP sampling support.',
      provenance: {
        backend: 'diagnostic',
        status: 'unavailable',
        authority: 'unavailable',
        reason_code: 'sampling_unavailable',
      },
      candidate_count: Math.min(searchResult.papers.length, max_candidates),
      candidate_diagnostics: [],
    });
  }
  const candidates = rankCandidates(paper, searchResult.papers, max_candidates);
  const candidateDiagnostics = candidates.map(candidate => ({
    candidate_key: candidate.candidate_key,
    recid: candidate.paper.recid,
    prior_signals: candidate.prior_signals,
  }));

  if (candidates.length === 0) {
    return buildResult({
      status: 'no_match',
      paper,
      reason: 'No bounded provenance candidates were found.',
      provenance: {
        backend: 'diagnostic',
        status: 'unavailable',
        authority: 'unavailable',
        reason_code: 'no_candidates_found',
      },
      candidate_count: 0,
      candidate_diagnostics: candidateDiagnostics,
    });
  }

  const inputHash = sha256Hex(JSON.stringify({
    recid,
    search_query: searchQuery,
    input_review_hint: firstReviewClassification?.review_type ?? 'unknown',
    candidates: candidates.map(candidate => ({
      candidate_key: candidate.candidate_key,
      recid: candidate.paper.recid,
      title: candidate.paper.title,
      prior_signals: candidate.prior_signals,
    })),
  }));

  const createMessage = ctx.createMessage;
  if (!createMessage) {
    return buildResult({
      status: 'sampling_unavailable',
      paper,
      reason: 'Semantic provenance adjudication requires MCP sampling support.',
      provenance: {
        backend: 'diagnostic',
        status: 'unavailable',
        authority: 'unavailable',
        reason_code: 'sampling_unavailable',
        prompt_version: promptVersion,
        input_hash: inputHash,
      },
      candidate_count: candidates.length,
      candidate_diagnostics: candidateDiagnostics,
    });
  }
  let response: CreateMessageResult;
  try {
    response = await createMessage({
      messages: [{
        role: 'user',
        content: {
          type: 'text',
          text: buildProvenanceMatchingPrompt({
            prompt_version: promptVersion,
            input_paper: {
              recid: paper.recid,
              title: paper.title,
              abstract: paper.abstract || '',
              authors: paper.authors || [],
              year: paper.year,
              publication_summary: paper.publication_summary,
              publication_type: paper.publication_type,
              document_type: paper.document_type,
              review_hint: firstReviewClassification ? `${firstReviewClassification.review_type}:${firstReviewClassification.provenance.reason_code}` : undefined,
              conference_hint: `${classified.conference_classification.decision}:${classified.conference_classification.provenance.reason_code}`,
            },
            candidates: candidates.map(candidate => ({
              candidate_key: candidate.candidate_key,
              recid: candidate.paper.recid,
              title: candidate.paper.title,
              abstract: (candidate.paper as PaperSummary & { abstract?: string }).abstract,
              authors: candidate.paper.authors || [],
              year: candidate.paper.year,
              publication_summary: candidate.paper.publication_summary,
              publication_type: candidate.paper.publication_type,
              document_type: candidate.paper.document_type,
              prior_signals: candidate.prior_signals,
            })),
          }),
        },
      }],
      maxTokens: 900,
      metadata: buildToolSamplingMetadata({
        tool: INSPIRE_TRACE_ORIGINAL_SOURCE,
        module: 'sem12_provenance_matcher',
        promptVersion,
        costClass: 'medium',
      }),
    });
  } catch {
    return buildResult({
      status: 'sampling_unavailable',
      paper,
      reason: 'Semantic provenance adjudication failed before receiving a model response.',
      provenance: {
        backend: 'mcp_sampling',
        status: 'unavailable',
        authority: 'unavailable',
        reason_code: 'sampling_error',
        prompt_version: promptVersion,
        input_hash: inputHash,
      },
      candidate_count: candidates.length,
      candidate_diagnostics: candidateDiagnostics,
    });
  }

  const parsed = parseProvenanceMatchingResponse(extractSamplingText(response.content));
  if (!parsed) {
    return buildResult({
      status: 'uncertain',
      paper,
      reason: 'Semantic provenance adjudication returned invalid JSON.',
      provenance: {
        backend: 'mcp_sampling',
        status: 'invalid',
        authority: 'unavailable',
        reason_code: 'invalid_response',
        prompt_version: promptVersion,
        input_hash: inputHash,
        model: response.model,
      },
      candidate_count: candidates.length,
      candidate_diagnostics: candidateDiagnostics,
    });
  }

  const selectedCandidate = parsed.selected_candidate_key
    ? candidates.find(candidate => candidate.candidate_key === parsed.selected_candidate_key)
    : undefined;
  if (parsed.status === 'matched' && !selectedCandidate) {
    return buildResult({
      status: 'uncertain',
      paper,
      reason: 'Model selected a candidate outside the bounded candidate set.',
      provenance: {
        backend: 'mcp_sampling',
        status: 'invalid',
        authority: 'unavailable',
        reason_code: 'candidate_not_in_set',
        prompt_version: promptVersion,
        input_hash: inputHash,
        model: response.model,
      },
      candidate_count: candidates.length,
      candidate_diagnostics: candidateDiagnostics,
    });
  }

  return buildResult({
    status: parsed.status,
    paper,
    original_paper: parsed.status === 'matched' ? selectedCandidate?.paper ?? null : null,
    relationship: parsed.relationship,
    confidence: parsed.confidence,
    reason: parsed.reason,
    provenance: {
      backend: 'mcp_sampling',
      status: 'applied',
      authority: 'semantic_conclusion',
      reason_code: parsed.reason_code,
      prompt_version: promptVersion,
      input_hash: inputHash,
      model: response.model,
    },
    candidate_count: candidates.length,
    candidate_diagnostics: candidateDiagnostics,
  });
}

export async function batchTraceToOriginal(
  recids: string[],
  options?: { min_similarity?: number; max_candidates?: number },
  ctx: SamplingContext = {},
): Promise<{
  papers: PaperSummary[];
  traced: number;
  failed: number;
  trace_map: Map<string, string>;
}> {
  const papers: PaperSummary[] = [];
  const traceMap = new Map<string, string>();
  let traced = 0;
  let failed = 0;

  for (const recid of recids) {
    try {
      const paper = await api.getPaper(recid);
      const classified = classifyPaper(paper);
      if (classified.is_conference) {
        const result = await traceToOriginal({ recid, ...options }, ctx);
        if (result.success && result.original_paper) {
          papers.push(result.original_paper);
          traceMap.set(recid, result.original_paper.recid!);
          traced += 1;
        } else {
          papers.push(paper);
          failed += 1;
        }
      } else {
        papers.push(paper);
      }
    } catch {
      try {
        papers.push(await api.getPaper(recid));
      } catch {
        failed += 1;
      }
    }
  }

  return { papers, traced, failed, trace_map: traceMap };
}
