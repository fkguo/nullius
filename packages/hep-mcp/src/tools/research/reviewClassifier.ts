import type { CreateMessageRequestParamsBase, CreateMessageResult } from '@modelcontextprotocol/sdk/types.js';
import { INSPIRE_CLASSIFY_REVIEWS } from '@autoresearch/shared';
import * as api from '../../api/client.js';
import { buildToolSamplingMetadata } from '../../core/sampling-metadata.js';
import { validateRecids } from './config.js';
import { buildReviewAssessmentPrompt, extractSamplingText, parseReviewAssessmentResponse } from './semantic/reviewSampling.js';
import type { SemanticAssessmentProvenance } from './semantic/semanticProvenance.js';
import { sha256Hex } from './semantic/semanticProvenance.js';

export type ReviewType = 'catalog' | 'critical' | 'consensus' | 'uncertain';
export type CoverageScope = 'narrow' | 'moderate' | 'comprehensive' | 'uncertain';
export type Recency = 'current' | 'dated' | 'historical';

export interface ReviewClassification {
  recid: string;
  title: string;
  review_type: ReviewType;
  coverage: {
    paper_count: number;
    scope: CoverageScope;
    author_diversity: 'single_group' | 'multi_group' | 'community';
  };
  potential_biases: string[];
  recency: Recency;
  age_years: number;
  classification_confidence: 'high' | 'medium' | 'low';
  provenance: SemanticAssessmentProvenance;
}

export interface ClassifyReviewsParams {
  recids: string[];
  current_threshold_years?: number;
}

export interface ClassifyReviewsResult {
  success: boolean;
  error?: string;
  classifications: ReviewClassification[];
  summary: {
    total: number;
    by_type: Record<ReviewType, number>;
    uncertain_count: number;
  };
  recommendation?: string;
}

type ReviewSamplingContext = {
  createMessage?: (params: CreateMessageRequestParamsBase) => Promise<CreateMessageResult>;
};

function determineRecency(ageYears: number, threshold: number): Recency {
  if (ageYears <= threshold) return 'current';
  if (ageYears <= threshold * 3) return 'dated';
  return 'historical';
}

function estimateAuthorDiversity(authorCount: number): 'single_group' | 'multi_group' | 'community' {
  if (authorCount >= 20) return 'community';
  if (authorCount >= 5) return 'multi_group';
  return 'single_group';
}

function fallbackBiases(authorCount: number, referenceCount: number): string[] {
  const biases: string[] = [];
  if (authorCount === 1) biases.push('Single-author review requires extra manual scrutiny.');
  if (authorCount <= 3 && referenceCount >= 150) biases.push('Small author team relative to the claimed literature coverage.');
  return biases;
}

async function estimatePaperCount(recid: string): Promise<number> {
  try {
    return (await api.getReferences(recid)).length;
  } catch {
    return 0;
  }
}

async function classifySingleReview(
  recid: string,
  currentThresholdYears: number,
  ctx: ReviewSamplingContext,
): Promise<ReviewClassification> {
  const unavailable = (
    reasonCode: string,
    status: 'invalid' | 'abstained' | 'unavailable',
    backend: 'mcp_sampling' | 'diagnostic' = 'diagnostic',
    model?: string,
  ): ReviewClassification => ({
    recid,
    title: `Unavailable review (${recid})`,
    review_type: 'uncertain',
    coverage: {
      paper_count: 0,
      scope: 'uncertain',
      author_diversity: 'single_group',
    },
    potential_biases: ['Paper metadata unavailable; manual review required.'],
    recency: 'historical',
    age_years: 0,
    classification_confidence: 'low',
    provenance: {
      backend,
      status,
      authority: 'unavailable',
      reason_code: reasonCode,
      model,
    },
  });

  try {
    const [paper, paperCount] = await Promise.all([api.getPaper(recid), estimatePaperCount(recid)]);
    const currentYear = new Date().getFullYear();
    const authorCount = paper.author_count ?? paper.authors?.length ?? 0;
    const ageYears = currentYear - (paper.year || currentYear);
    const promptVersion = 'sem05_review_authority_v2';
    const inputHash = sha256Hex(JSON.stringify({
      recid,
      title: paper.title,
      abstract: paper.abstract || '',
      year: paper.year ?? null,
      citation_count: paper.citation_count ?? null,
      author_count: authorCount,
      paper_count: paperCount,
      publication_summary: paper.publication_summary ?? '',
      publication_type: paper.publication_type ?? [],
      document_type: paper.document_type ?? [],
      collaborations: paper.collaborations ?? [],
    }));

    const unavailableForPaper = (
      reasonCode: string,
      status: 'invalid' | 'abstained' | 'unavailable',
      backend: 'mcp_sampling' | 'diagnostic' = 'diagnostic',
      model?: string,
    ): ReviewClassification => ({
      recid,
      title: paper.title,
      review_type: 'uncertain',
      coverage: {
        paper_count: paperCount,
        scope: 'uncertain',
        author_diversity: estimateAuthorDiversity(authorCount),
      },
      potential_biases: fallbackBiases(authorCount, paperCount),
      recency: determineRecency(ageYears, currentThresholdYears),
      age_years: ageYears,
      classification_confidence: 'low',
      provenance: {
        backend,
        status,
        authority: 'unavailable',
        reason_code: reasonCode,
        prompt_version: promptVersion,
        input_hash: inputHash,
        model,
      },
    });

    if (!ctx.createMessage) {
      return unavailableForPaper('sampling_required', 'unavailable', 'mcp_sampling');
    }

    let response: CreateMessageResult;
    try {
      response = await ctx.createMessage({
        messages: [{
          role: 'user',
          content: {
            type: 'text',
            text: buildReviewAssessmentPrompt({
              prompt_version: promptVersion,
              title: paper.title,
              abstract: paper.abstract || '',
              year: paper.year,
              citation_count: paper.citation_count,
              author_count: authorCount,
              reference_count: paperCount,
              publication_summary: paper.publication_summary,
              publication_type: paper.publication_type,
              document_type: paper.document_type,
              collaborations: paper.collaborations,
            }),
          },
        }],
        maxTokens: 700,
        metadata: buildToolSamplingMetadata({
          tool: INSPIRE_CLASSIFY_REVIEWS,
          module: 'sem05_review_authority',
          promptVersion,
          costClass: 'high',
        }),
      });
    } catch {
      return unavailableForPaper('sampling_error', 'unavailable', 'mcp_sampling');
    }

    const parsed = parseReviewAssessmentResponse(extractSamplingText(response.content));
    if (!parsed) return unavailableForPaper('invalid_response', 'invalid', 'mcp_sampling', response.model);
    if (parsed.abstain) return unavailableForPaper('model_abstained', 'abstained', 'mcp_sampling', response.model);

    return {
      recid,
      title: paper.title,
      review_type: parsed.review_type,
      coverage: {
        paper_count: paperCount,
        scope: parsed.scope,
        author_diversity: estimateAuthorDiversity(authorCount),
      },
      potential_biases: [...new Set([...fallbackBiases(authorCount, paperCount), ...parsed.potential_biases])].slice(0, 5),
      recency: determineRecency(ageYears, currentThresholdYears),
      age_years: ageYears,
      classification_confidence: parsed.classification_confidence,
      provenance: {
        backend: 'mcp_sampling',
        status: 'applied',
        authority: 'semantic_conclusion',
        reason_code: parsed.reason || 'semantic_assessment',
        prompt_version: promptVersion,
        input_hash: inputHash,
        model: response.model,
      },
    };
  } catch (error) {
    console.debug(`[hep-mcp] classifyReviews (recid=${recid}): Skipped - ${error instanceof Error ? error.message : String(error)}`);
    return unavailable('paper_fetch_failed', 'unavailable');
  }
}

function buildRecommendation(classifications: ReviewClassification[]): string | undefined {
  if (classifications.length === 0) return undefined;
  const consensus = classifications.filter(item => item.review_type === 'consensus');
  if (consensus.length > 0) return `Prioritize ${consensus.length} consensus-style review(s); they provide the strongest semantic baseline.`;
  const uncertain = classifications.filter(item => item.review_type === 'uncertain').length;
  if (uncertain === classifications.length) return 'Only diagnostic priors or unavailable records are available for these reviews; inspect them manually.';
  return 'Use high-confidence review classifications first and keep uncertain cases in manual review.';
}

export async function classifyReviews(
  params: ClassifyReviewsParams,
  ctx: ReviewSamplingContext = {},
): Promise<ClassifyReviewsResult> {
  const validationError = validateRecids(params.recids);
  if (validationError) {
    return {
      success: false,
      error: validationError,
      classifications: [],
      summary: {
        total: 0,
        by_type: { catalog: 0, critical: 0, consensus: 0, uncertain: 0 },
        uncertain_count: 0,
      },
    };
  }

  const currentThresholdYears = params.current_threshold_years ?? 3;
  const results = await Promise.all(params.recids.map(recid => classifySingleReview(recid, currentThresholdYears, ctx)));
  const classifications = results;
  const byType: Record<ReviewType, number> = { catalog: 0, critical: 0, consensus: 0, uncertain: 0 };

  for (const item of classifications) byType[item.review_type] += 1;

  const unavailable = classifications.filter(item => item.provenance.status !== 'applied');
  return {
    success: unavailable.length === 0,
    error: unavailable.length > 0
      ? 'Review classification failed closed for one or more papers; inspect provenance for unavailable or invalid semantic assessments.'
      : undefined,
    classifications,
    summary: {
      total: classifications.length,
      by_type: byType,
      uncertain_count: classifications.filter(item => item.review_type === 'uncertain').length,
    },
    recommendation: unavailable.length === 0 ? buildRecommendation(classifications) : undefined,
  };
}
