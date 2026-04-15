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

  /** Evidence grading results */
  evidence?: EvidenceGradingResult;

  /** Critical questions results */
  questions?: CriticalQuestionsResult;

  /** Assumption tracking results */
  assumptions?: AssumptionTrackerResult;

  /** Integrated assessment */
  integrated_assessment: {
    /** Overall reliability score (0-1) */
    reliability_score: number;
    /** Overall risk level */
    risk_level: 'low' | 'medium' | 'high';
    /** Key concerns identified */
    key_concerns: string[];
    /** Strengths identified */
    strengths: string[];
    /** Recommended actions */
    recommendations: string[];
    /** One-line verdict */
    verdict: string;
  };
}

type CriticalAnalysisContext = {
  createMessage?: (params: CreateMessageRequestParamsBase) => Promise<CreateMessageResult>;
};

// ─────────────────────────────────────────────────────────────────────────────
// Helper Functions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Get reliability score weights from config.
 *
 * Scientific Reliability Philosophy:
 * In physics research, reliability stems from three pillars: empirical evidence,
 * methodological rigor, and theoretical foundations. These weights reflect the
 * relative importance of each pillar in assessing whether claims can be trusted.
 *
 * Weight Rationale:
 *
 * 1. Evidence (40%): Highest weight
 *    - Represents empirical support for claims (citations, confirmations, experimental data)
 *    - In experimental physics, "extraordinary claims require extraordinary evidence"
 *    - Direct empirical validation is the gold standard for scientific reliability
 *    - Independent confirmations from different research groups are the strongest indicator
 *
 * 2. Critical Questions (30%): Second priority
 *    - Captures methodological soundness and procedural red flags
 *    - Includes: statistical validity, self-citation bias, retractions, comments/errata
 *    - A paper with strong evidence but methodological flaws has limited reliability
 *    - Red flags (e.g., retracted work, excessive self-citation) can invalidate strong evidence
 *
 * 3. Assumptions (30%): Equal to questions
 *    - Measures foundational stability and dependency risks
 *    - Tracks which theoretical assumptions underpin the conclusions
 *    - If core assumptions are challenged, conclusions become fragile
 *    - In theoretical physics, assumption validity is as critical as methodology
 *
 * Why Equal Weighting (30-30) for Questions & Assumptions:
 * - Questions assess "how" (methodology), assumptions assess "why" (foundations)
 * - Both are complementary aspects of rigor: one checks process, one checks basis
 * - A paper can fail on either dimension: flawed methods OR invalid assumptions
 *
 * Total: 40% + 30% + 30% = 100% of weighted contributions
 *
 * Note: Base score (0.5) provides neutral starting point when data is limited,
 * preventing extreme scores from partial information.
 */
function getReliabilityWeights() {
  const config = getConfig().criticalResearch;
  return {
    evidence: config?.integrationWeightEvidence ?? 0.4,
    questions: config?.integrationWeightQuestions ?? 0.3,
    assumptions: config?.integrationWeightAssumptions ?? 0.3,
    baseScore: config?.integrationBaseScore ?? 0.5,
  };
}

/**
 * Calculate integrated reliability score from all analysis components.
 *
 * The score combines evidence grading, critical questions, and assumption tracking
 * using weighted averaging. Each component contributes to the final score based on
 * RELIABILITY_WEIGHTS, reflecting its importance in scientific reliability assessment.
 *
 * Scoring Logic:
 * - Starts with neutral base (0.5) to avoid extreme scores from partial data
 * - Each available component adds its weighted contribution
 * - Final normalization accounts for missing components to maintain score range
 *
 * @param evidence - Evidence grading results (40% weight if available)
 * @param questions - Critical questions results (30% weight if available)
 * @param assumptions - Assumption tracking results (30% weight if available)
 * @returns Reliability score in range [0, 1], where:
 *          - 0.7+: High reliability (well-supported, minimal concerns)
 *          - 0.4-0.7: Moderate reliability (mixed signals)
 *          - <0.4: Low reliability (significant concerns)
 */
function calculateIntegratedScore(
  evidence?: EvidenceGradingResult,
  questions?: CriticalQuestionsResult,
  assumptions?: AssumptionTrackerResult
): number {
  const weights = getReliabilityWeights();
  let score = weights.baseScore; // Base score: neutral starting point for partial data
  let weight = 0;

  if (evidence?.success && evidence.overall_reliability !== undefined) {
    score += evidence.overall_reliability * weights.evidence;
    weight += weights.evidence;
  }

  if (questions?.success && questions.reliability_score !== null && questions.reliability_score !== undefined) {
    score += questions.reliability_score * weights.questions;
    weight += weights.questions;
  }

  if (assumptions?.success && assumptions.analysis) {
    // Invert fragility to get reliability: high fragility = low reliability
    const assumptionReliability = 1 - assumptions.analysis.fragility_score;
    score += assumptionReliability * weights.assumptions;
    weight += weights.assumptions;
  }

  // If no components available, return neutral base score
  if (weight === 0) return weights.baseScore;

  // Normalize by total weight + base, keeping score near baseScore when data is limited
  return score / (weight + weights.baseScore);
}

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

    if (questions.red_flags.length === 0 && questions.provenance.authority === 'semantic_conclusion') {
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

/**
 * Generate one-line verdict
 */
function generateVerdict(
  riskLevel: 'low' | 'medium' | 'high',
  reliabilityScore: number,
  concerns: string[],
  strengths: string[]
): string {
  if (riskLevel === 'high') {
    return 'HIGH RISK: Significant concerns identified. Careful verification recommended before relying on this work.';
  }

  if (riskLevel === 'medium') {
    if (strengths.length > concerns.length) {
      return 'MODERATE: Generally reliable but some concerns warrant attention.';
    }
    return 'MODERATE RISK: Mixed signals detected. Review specific concerns before proceeding.';
  }

  if (reliabilityScore > 0.7) {
    return 'RELIABLE: Well-supported work with minimal concerns. Suitable for citation and extension.';
  }

  return 'LOW RISK: No major concerns identified, but limited independent verification available.';
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
        evidence,
        questions,
        assumptions,
        integrated_assessment: {
          reliability_score: 0,
          risk_level: 'high',
          key_concerns: componentFailures,
          strengths: [],
          recommendations: ['Provide MCP client sampling support and rerun the bounded critical analysis.'],
          verdict: 'Critical analysis unavailable because semantic sub-analyses did not complete.',
        },
      };
    }

    // Calculate integrated metrics
    const reliabilityScore = calculateIntegratedScore(evidence, questions, assumptions);
    const riskLevel = determineRiskLevel(evidence, questions, assumptions);
    const concerns = extractKeyConcerns(evidence, questions, assumptions);
    const strengths = extractStrengths(evidence, questions, assumptions);
    const recommendations = generateRecommendations(riskLevel, evidence, questions, assumptions);
    const verdict = generateVerdict(riskLevel, reliabilityScore, concerns, strengths);

    return {
      paper_recid: recid,
      paper_title: paperTitle,
      success: true,
      evidence,
      questions,
      assumptions,
      integrated_assessment: {
        reliability_score: Math.round(reliabilityScore * 100) / 100,
        risk_level: riskLevel,
        key_concerns: concerns,
        strengths,
        recommendations,
        verdict,
      },
    };

  } catch (error) {
    return {
      paper_recid: recid,
      paper_title: paperTitle,
      success: false,
      error: error instanceof Error ? error.message : String(error),
      integrated_assessment: {
        reliability_score: 0,
        risk_level: 'high',
        key_concerns: ['Analysis failed - unable to assess'],
        strengths: [],
        recommendations: ['Manual review required'],
        verdict: 'UNABLE TO ASSESS: Analysis encountered errors.',
      },
    };
  }
}
