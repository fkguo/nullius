import type { CreateMessageRequestParamsBase, CreateMessageResult } from '@modelcontextprotocol/sdk/types.js';
import * as api from '../../api/client.js';
import { extractClaimsFromAbstract } from '../../core/semantics/claimExtraction.js';
import { gradeClaimAgainstEvidenceBundle } from '../../core/semantics/evidenceClaimGrading.js';
import { analyzeCitationStance } from '../../core/semantics/citationStanceHeuristics.js';
import type {
  CitationStance,
  ClaimSemanticGradeV1,
  ClaimStanceV1,
  ConfidenceLevel,
  EvidenceLevel,
} from '../../core/semantics/claimTypes.js';
import { collectClaimEvidenceCandidates } from './claimEvidenceSearch.js';
import { DEFAULT_CRITICAL_RESEARCH_CONFIG, getConfig, validateRecid } from './config.js';
import { emptyResult, scoreClaim, toLegacyGrade, type EvidenceGrade, type EvidenceGradingResult } from './evidenceGradeScoring.js';

export { analyzeCitationStance };
export type { CitationStance, ConfidenceLevel, EvidenceGrade, EvidenceGradingResult, EvidenceLevel };
export type { StanceResult } from '../../core/semantics/citationStanceHeuristics.js';

export interface EvidenceGradingParams {
  recid: string;
  search_confirmations?: boolean;
  max_search_results?: number;
}

export type EvidenceSamplingContext = {
  createMessage?: (params: CreateMessageRequestParamsBase) => Promise<CreateMessageResult>;
};

export async function gradeEvidence(
  params: EvidenceGradingParams,
  ctx: EvidenceSamplingContext = {},
): Promise<EvidenceGradingResult> {
  const recidError = validateRecid(params.recid);
  if (recidError) return emptyResult(params.recid || '', recidError);

  try {
    const paper = await api.getPaper(params.recid);
    const abstractText = paper.abstract || '';
    const extractedClaims = await extractClaimsFromAbstract(abstractText, ctx, {
      prompt_version: 'sem02_claim_extraction_v1',
      max_claims: (getConfig().criticalResearch ?? DEFAULT_CRITICAL_RESEARCH_CONFIG).evidenceMaxClaims,
    });
    if (extractedClaims.length === 0) {
      return {
        ...emptyResult(params.recid),
        paper_title: paper.title,
        paper_year: paper.year,
        paper_abstract: abstractText,
        success: true,
        overall_reliability: 0.5,
        warnings: ['No claims could be extracted from abstract'],
      };
    }

    const maxSearchResults = Number.isInteger(params.max_search_results) && (params.max_search_results ?? 0) > 0 ? params.max_search_results! : 20;
    const titleByRef = new Map<string, { recid: string; title: string }>();
    const warnings = new Set<string>();
    const claimGrades: ClaimSemanticGradeV1[] = [];

    for (const claim of extractedClaims) {
      const evidenceBundle = await collectClaimEvidenceCandidates({
        claimText: claim.claim_text,
        originalRecid: params.recid,
        originalAuthors: paper.authors,
        maxResults: maxSearchResults,
        searchConfirmations: params.search_confirmations !== false,
      });
      evidenceBundle.warnings.forEach(warning => warnings.add(warning));
      evidenceBundle.evidenceItems.forEach(item => {
        if (item.recid && item.title) titleByRef.set(item.evidence_ref, { recid: item.recid, title: item.title });
      });
      claimGrades.push(await gradeClaimAgainstEvidenceBundle(claim, evidenceBundle.evidenceItems, ctx, {
        prompt_version: 'sem02_claim_evidence_v1',
        bundle_prompt_version: 'sem03_claim_bundle_v1',
      }));
    }

    const mainClaims = claimGrades.map(grade => toLegacyGrade(grade, titleByRef));
    const overallReliability = mainClaims.length > 0 ? mainClaims.reduce((sum, grade) => sum + scoreClaim(grade), 0) / mainClaims.length : 0;
    const gradeDistribution = claimGrades.reduce<Record<ClaimStanceV1, number>>((acc, grade) => {
      acc[grade.aggregate_stance] += 1;
      return acc;
    }, { supported: 0, weak_support: 0, not_supported: 0, mixed: 0, conflicting: 0 });

    return {
      paper_recid: params.recid,
      paper_title: paper.title,
      paper_year: paper.year,
      paper_abstract: abstractText,
      success: true,
      claim_grades: claimGrades,
      main_claims: mainClaims,
      overall_reliability: overallReliability,
      warnings: [...warnings],
      claim_count: claimGrades.length,
      grade_distribution: gradeDistribution,
      summary: {
        total_claims: mainClaims.length,
        well_established: mainClaims.filter(item => item.confidence === 'high').length,
        controversial: mainClaims.filter(item => item.confidence === 'controversial').length,
        orphan: mainClaims.filter(item => item.is_orphan).length,
      },
    };
  } catch (error) {
    return { ...emptyResult(params.recid, error instanceof Error ? error.message : String(error)), success: false };
  }
}
