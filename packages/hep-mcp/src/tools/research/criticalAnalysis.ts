/**
 * Critical Analysis Tool
 * Integrated critical analysis combining all analysis modules
 *
 * Provides a comprehensive "AI scientist" view of a paper including:
 * - Evidence grading
 * - Critical questions
 * - Red flag detection
 * - Assumption tracking
 */

import { gradeEvidence, type EvidenceGradingResult } from './evidenceGrading.js';
import { generateCriticalQuestions, type CriticalQuestionsResult } from './criticalQuestions.js';
import { trackAssumptions, type AssumptionTrackerResult } from './assumptionTracker.js';
import { getConfig } from './config.js';
import type { CreateMessageRequestParamsBase, CreateMessageResult } from '@modelcontextprotocol/sdk/types.js';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface CriticalAnalysisParams {
  /** INSPIRE recid of the paper to analyze */
  recid: string;
  /** Include evidence grading (default: true) */
  include_evidence?: boolean;
  /** Include critical questions (default: true) */
  include_questions?: boolean;
  /** Include assumption tracking (default: true) */
  include_assumptions?: boolean;
  /** Check for challenges and confirmations (default: true) */
  check_literature?: boolean;
  /**
   * Whether to search for independent confirmations in evidence grading.
   * Applies only when `include_evidence=true`.
   */
  search_confirmations?: boolean;
  /**
   * Maximum number of papers to consider when searching for confirmations per claim.
   * Applies only when `include_evidence=true` and `search_confirmations=true`.
   */
  max_search_results?: number;
  /**
   * Assumption tracing depth when expanding into references.
   * Applies only when `include_assumptions=true`.
   */
  assumption_max_depth?: number;
}

export interface CriticalAnalysisResult {
  paper_recid: string;
  paper_title: string;
  success: boolean;
  error?: string;
  component_status: {
    evidence: {
      requested: boolean;
      status: 'completed' | 'unavailable' | 'invalid' | 'abstained' | 'not_requested';
      reason_code: string | null;
      error: string | null;
      available_output: boolean;
    };
    questions: {
      requested: boolean;
      status: 'completed' | 'unavailable' | 'invalid' | 'abstained' | 'not_requested';
      reason_code: string | null;
      error: string | null;
      available_output: boolean;
    };
    assumptions: {
      requested: boolean;
      status: 'completed' | 'unavailable' | 'invalid' | 'abstained' | 'not_requested';
      reason_code: string | null;
      error: string | null;
      available_output: boolean;
    };
  };

  /** Evidence grading results */
  evidence?: EvidenceGradingResult;

  /** Critical questions results */
  questions?: CriticalQuestionsResult;

  /** Assumption tracking results */
  assumptions?: AssumptionTrackerResult;

  /** Integrated assessment */
  integrated_assessment: {
    /** Overall risk level */
    risk_level: 'low' | 'medium' | 'high';
    /** Key concerns identified */
    key_concerns: string[];
    /** Strengths identified */
    strengths: string[];
    /** Recommended actions */
    recommendations: string[];
  };
}

type CriticalAnalysisContext = {
  createMessage?: (params: CreateMessageRequestParamsBase) => Promise<CreateMessageResult>;
};

type CriticalAnalysisComponentStatus = CriticalAnalysisResult['component_status']['evidence'];

function hasAvailableEvidenceOutput(result: EvidenceGradingResult | undefined): boolean {
  return Boolean(result && (
    result.success
    || (Array.isArray(result.main_claims) && result.main_claims.length > 0)
    || (Array.isArray(result.warnings) && result.warnings.length > 0)
  ));
}

function hasAvailableQuestionsOutput(result: CriticalQuestionsResult | undefined): boolean {
  return Boolean(result && (
    result.success
    || (Array.isArray(result.red_flags) && result.red_flags.length > 0)
    || Object.values(result.questions ?? {}).some(group => Array.isArray(group) && group.length > 0)
  ));
}

function hasAvailableAssumptionsOutput(result: AssumptionTrackerResult | undefined): boolean {
  return Boolean(result && (
    result.success
    || result.analysis !== null
    || Boolean(result.risk_assessment)
  ));
}

function unavailableComponentStatus(requested: boolean) {
  return {
    requested,
    status: requested ? 'unavailable' as const : 'not_requested' as const,
    reason_code: null,
    error: null,
    available_output: false,
  };
}

function componentStatus(params: {
  requested: boolean;
  result: EvidenceGradingResult | CriticalQuestionsResult | AssumptionTrackerResult | undefined;
  availableOutput: boolean;
}): CriticalAnalysisComponentStatus {
  if (!params.requested) return unavailableComponentStatus(false);
  if (!params.result) return unavailableComponentStatus(true);
  const result = params.result;
  if (result.success === true) {
    return {
      requested: true,
      status: 'completed' as const,
      reason_code: null,
      error: null,
      available_output: params.availableOutput,
    };
  }
  const provenance = 'provenance' in result && result.provenance && typeof result.provenance === 'object'
    ? result.provenance
    : null;
  const rawStatus = provenance?.status ?? 'unavailable';
  const normalizedStatus: CriticalAnalysisComponentStatus['status'] =
    rawStatus === 'invalid' || rawStatus === 'abstained' || rawStatus === 'unavailable'
    ? rawStatus
    : 'unavailable';
  return {
    requested: true,
    status: normalizedStatus,
    reason_code: provenance?.reason_code ?? null,
    error: result.error ?? null,
    available_output: params.availableOutput,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Helper Functions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Determine overall risk level
 */
function determineRiskLevel(
  evidence?: EvidenceGradingResult,
  questions?: CriticalQuestionsResult,
  assumptions?: AssumptionTrackerResult
): 'low' | 'medium' | 'high' {
  const config = getConfig().criticalResearch;
  const fragilityHighThreshold = config?.fragilityHighThreshold ?? 0.7;
  const fragilityMediumThreshold = config?.fragilityMediumThreshold ?? 0.4;
  const riskHighThreshold = config?.riskScoreHighThreshold ?? 5;
  const riskMediumThreshold = config?.riskScoreMediumThreshold ?? 2;

  let riskScore = 0;

  // Evidence-based risk
  if (evidence?.success) {
    if (evidence.summary.controversial > 0) riskScore += 2;
    if (evidence.summary.orphan > evidence.summary.total_claims / 2) riskScore += 1;
    if (evidence.warnings.length >= 2) riskScore += 1;
  }

  // Question-based risk (red flags)
  if (questions?.success) {
    const concernCount = questions.red_flags.filter(f => f.severity === 'concern').length;
    const warningCount = questions.red_flags.filter(f => f.severity === 'warning').length;
    riskScore += concernCount * 2 + warningCount;
  }

  // Assumption-based risk
  if (assumptions?.success && assumptions.analysis) {
    if (assumptions.analysis.fragility_score > fragilityHighThreshold) riskScore += 2;
    else if (assumptions.analysis.fragility_score > fragilityMediumThreshold) riskScore += 1;

    if (assumptions.analysis.summary.challenged_count >= 2) riskScore += 2;
  }

  if (riskScore >= riskHighThreshold) return 'high';
  if (riskScore >= riskMediumThreshold) return 'medium';
  return 'low';
}

/**
 * Extract key concerns from all analyses
 */
function extractKeyConcerns(
  evidence?: EvidenceGradingResult,
  questions?: CriticalQuestionsResult,
  assumptions?: AssumptionTrackerResult
): string[] {
  const concerns: string[] = [];

  // Evidence concerns
  if (evidence?.success) {
    for (const warning of evidence.warnings) {
      concerns.push(`[Evidence] ${warning}`);
    }

    const controversial = evidence.main_claims.filter(c => c.confidence === 'controversial');
    if (controversial.length > 0) {
      concerns.push(`[Evidence] ${controversial.length} claim(s) are controversial`);
    }
  }

  // Red flag concerns
  if (questions?.success) {
    for (const flag of questions.red_flags) {
      if (flag.severity === 'concern') {
        concerns.push(`[Red Flag] ${flag.description}`);
      }
    }
  }

  // Assumption concerns
  if (assumptions?.success && assumptions.analysis) {
    const challenged = assumptions.analysis.summary.challenged_count;
    if (challenged > 0) {
      concerns.push(`[Assumptions] ${challenged} assumption(s) have been challenged`);
    }

    if (assumptions.analysis.fragility_score > 0.5) {
      concerns.push('[Assumptions] High fragility score - conclusions may be sensitive to assumptions');
    }
  }

  const config = getConfig().criticalResearch;
  return concerns.slice(0, config?.maxConcerns ?? 5);
}

/**
 * Extract strengths from all analyses
 */
function extractStrengths(
  evidence?: EvidenceGradingResult,
  questions?: CriticalQuestionsResult,
  assumptions?: AssumptionTrackerResult
): string[] {
  const strengths: string[] = [];

  // Evidence strengths
  if (evidence?.success) {
    const wellEstablished = evidence.main_claims.filter(
      c => c.confidence === 'high' || (c.confidence === 'medium' && c.independent_confirmations >= 2)
    );
    if (wellEstablished.length > 0) {
      strengths.push(`${wellEstablished.length} claim(s) are well-established with independent confirmation`);
    }

    const discoveries = evidence.main_claims.filter(c => c.evidence_level === 'discovery');
    if (discoveries.length > 0) {
      strengths.push(`Contains ${discoveries.length} discovery-level claim(s)`);
    }
  }

  // Metrics strengths
  if (questions?.success) {
    if (questions.metrics.citation_count > 100) {
      strengths.push(`Well-cited paper (${questions.metrics.citation_count} citations)`);
    }

    if (questions.metrics.author_count > 10) {
      strengths.push('Large collaboration enhances credibility');
    }

    if (questions.red_flags.length === 0) {
      strengths.push('No red flags detected');
    }
  }

  // Assumption strengths
  if (assumptions?.success && assumptions.analysis) {
    const tested = assumptions.analysis.core_assumptions.filter(
      a => a.validation_status === 'tested'
    ).length;
    if (tested > 0) {
      strengths.push(`${tested} assumption(s) have been validated`);
    }

    if (assumptions.analysis.fragility_score < 0.3) {
      strengths.push('Low assumption fragility - conclusions are robust');
    }
  }

  const config = getConfig().criticalResearch;
  return strengths.slice(0, config?.maxStrengths ?? 5);
}

/**
 * Generate recommendations based on analysis
 */
function generateRecommendations(
  riskLevel: 'low' | 'medium' | 'high',
  evidence?: EvidenceGradingResult,
  questions?: CriticalQuestionsResult,
  assumptions?: AssumptionTrackerResult
): string[] {
  const recommendations: string[] = [];

  if (riskLevel === 'high') {
    recommendations.push('Exercise caution when citing or building upon this work');
    recommendations.push('Seek independent verification of key claims');
  }

  // Evidence-based recommendations
  if (evidence?.success) {
    const orphans = evidence.main_claims.filter(c => c.is_orphan);
    if (orphans.length > 0) {
      recommendations.push('Look for independent confirmation of "orphan" results');
    }

    if (evidence.summary.controversial > 0) {
      recommendations.push('Review the controversy in detail before accepting conclusions');
    }
  }

  // Question-based recommendations
  if (questions?.success) {
    if (questions.red_flags.some(f => f.type === 'comment_exists')) {
      recommendations.push('Read the published comments/errata for this paper');
    }

    if (questions.red_flags.some(f => f.type === 'high_self_citation')) {
      recommendations.push('Verify claims with external sources due to high self-citation');
    }
  }

  // Assumption-based recommendations
  if (assumptions?.risk_assessment) {
    recommendations.push(...assumptions.risk_assessment.recommendations);
  }

  // Deduplicate and limit
  const unique = [...new Set(recommendations)];
  const config = getConfig().criticalResearch;
  return unique.slice(0, config?.maxRecommendations ?? 5);
}

// ─────────────────────────────────────────────────────────────────────────────
// Main Function
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Perform comprehensive critical analysis of a paper
 */
export async function performCriticalAnalysis(
  params: CriticalAnalysisParams,
  ctx: CriticalAnalysisContext = {},
): Promise<CriticalAnalysisResult> {
  const {
    recid,
    include_evidence = true,
    include_questions = true,
    include_assumptions = true,
    check_literature = true,
    search_confirmations,
    max_search_results,
    assumption_max_depth,
  } = params;

  let paperTitle = 'Unknown';
  let evidence: EvidenceGradingResult | undefined;
  let questions: CriticalQuestionsResult | undefined;
  let assumptions: AssumptionTrackerResult | undefined;

  try {
    // Run analyses in parallel where possible
    const promises: Promise<void>[] = [];

    if (include_evidence) {
      promises.push(
        gradeEvidence({
          recid,
          search_confirmations: check_literature ? search_confirmations : false,
          max_search_results,
        }, {
          createMessage: ctx.createMessage,
        }).then(result => {
          evidence = result;
          if (result.paper_title) paperTitle = result.paper_title;
        })
      );
    }

    if (include_questions) {
      promises.push(
        generateCriticalQuestions({
          recid,
          check_comments: check_literature,
          check_self_citations: check_literature,
        }, {
          createMessage: ctx.createMessage,
        }).then(result => {
          questions = result;
          if (result.paper_title) paperTitle = result.paper_title;
        })
      );
    }

    if (include_assumptions) {
      promises.push(
        trackAssumptions({
          recid,
          max_depth: assumption_max_depth,
          check_challenges: check_literature,
        }, {
          createMessage: ctx.createMessage,
        }).then(result => {
          assumptions = result;
          if (result.analysis?.paper_title) paperTitle = result.analysis.paper_title;
        })
      );
    }

    await Promise.all(promises);

    const componentFailures: string[] = [];
    if (include_evidence && evidence && !evidence.success) {
      componentFailures.push(`evidence: ${evidence.error || 'semantic evidence grading failed'}`);
    }
    if (include_questions && questions && !questions.success) {
      componentFailures.push(`questions: ${questions.error || 'semantic question generation failed'}`);
    }
    if (include_assumptions && assumptions && !assumptions.success) {
      componentFailures.push(`assumptions: ${assumptions.error || 'semantic assumption tracking failed'}`);
    }
    if (componentFailures.length > 0) {
      return {
        paper_recid: recid,
        paper_title: paperTitle,
        success: false,
        error: `Critical analysis failed closed because semantic sub-analyses did not complete: ${componentFailures.join('; ')}`,
        component_status: {
          evidence: componentStatus({
            requested: include_evidence,
            result: evidence,
            availableOutput: hasAvailableEvidenceOutput(evidence),
          }),
          questions: componentStatus({
            requested: include_questions,
            result: questions,
            availableOutput: hasAvailableQuestionsOutput(questions),
          }),
          assumptions: componentStatus({
            requested: include_assumptions,
            result: assumptions,
            availableOutput: hasAvailableAssumptionsOutput(assumptions),
          }),
        },
        evidence,
        questions,
        assumptions,
        integrated_assessment: {
          risk_level: 'high',
          key_concerns: componentFailures,
          strengths: [],
          recommendations: ['Provide MCP client sampling support and rerun the bounded critical analysis.'],
        },
      };
    }

    const riskLevel = determineRiskLevel(evidence, questions, assumptions);
    const concerns = extractKeyConcerns(evidence, questions, assumptions);
    const strengths = extractStrengths(evidence, questions, assumptions);
    const recommendations = generateRecommendations(riskLevel, evidence, questions, assumptions);

    return {
      paper_recid: recid,
      paper_title: paperTitle,
      success: true,
      component_status: {
        evidence: componentStatus({
          requested: include_evidence,
          result: evidence,
          availableOutput: hasAvailableEvidenceOutput(evidence),
        }),
        questions: componentStatus({
          requested: include_questions,
          result: questions,
          availableOutput: hasAvailableQuestionsOutput(questions),
        }),
        assumptions: componentStatus({
          requested: include_assumptions,
          result: assumptions,
          availableOutput: hasAvailableAssumptionsOutput(assumptions),
        }),
      },
      evidence,
      questions,
      assumptions,
      integrated_assessment: {
        risk_level: riskLevel,
        key_concerns: concerns,
        strengths,
        recommendations,
      },
    };

  } catch (error) {
    return {
      paper_recid: recid,
      paper_title: paperTitle,
      success: false,
      error: error instanceof Error ? error.message : String(error),
      component_status: {
        evidence: unavailableComponentStatus(include_evidence),
        questions: unavailableComponentStatus(include_questions),
        assumptions: unavailableComponentStatus(include_assumptions),
      },
      integrated_assessment: {
        risk_level: 'high',
        key_concerns: ['Analysis failed - unable to assess'],
        strengths: [],
        recommendations: ['Manual review required'],
      },
    };
  }
}
