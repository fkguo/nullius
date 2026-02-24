/**
 * Assumption Tracker Module
 * Tracks assumptions and their validation status across papers
 *
 * Features:
 * - Assumption extraction from text
 * - Inherited assumption detection
 * - Challenge/validation detection
 * - Fragility scoring
 */

import * as api from '../../api/client.js';
import { getConfig, validateRecid, validateMaxDepth } from './config.js';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type AssumptionType = 'explicit' | 'implicit';
export type AssumptionSource = 'original' | 'inherited';
export type ValidationStatus = 'tested' | 'untested' | 'challenged' | 'refuted';

export interface AssumptionNode {
  /** The assumption text */
  assumption: string;
  /** Whether explicitly stated or implicit */
  type: AssumptionType;
  /** Whether original to this paper or inherited from references */
  source: AssumptionSource;
  /** Papers from which this assumption is inherited */
  inherited_from?: Array<{ recid: string; title: string; }>;
  /** Validation status */
  validation_status: ValidationStatus;
  /** Papers that challenge this assumption */
  challenge_papers?: Array<{ recid: string; title: string; }>;
  /** Papers that support/test this assumption */
  supporting_papers?: Array<{ recid: string; title: string; }>;
  /** Category of assumption */
  category: 'theoretical' | 'methodological' | 'experimental' | 'phenomenological';
}

export interface AssumptionChain {
  /** Paper being analyzed */
  paper_recid: string;
  paper_title: string;
  paper_year?: number;
  /** Core assumptions identified */
  core_assumptions: AssumptionNode[];
  /** Fragility score (0-1, higher = more fragile) */
  fragility_score: number;
  /** Most critical (fragile) dependencies */
  critical_dependencies: string[];
  /** Summary */
  summary: {
    total_assumptions: number;
    explicit_count: number;
    implicit_count: number;
    inherited_count: number;
    challenged_count: number;
    untested_count: number;
  };
}

export interface AssumptionTrackerParams {
  /** INSPIRE recid of the paper to analyze */
  recid: string;
  /** Maximum depth for tracing inherited assumptions (default: 2) */
  max_depth?: number;
  /** Check for challenges in citing papers (default: true) */
  check_challenges?: boolean;
}

export interface AssumptionTrackerResult {
  success: boolean;
  error?: string;
  /** Assumption chain analysis */
  analysis: AssumptionChain | null;
  /** Risk assessment */
  risk_assessment?: {
    level: 'low' | 'medium' | 'high';
    description: string;
    recommendations: string[];
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

// Keywords indicating explicit assumptions
const EXPLICIT_ASSUMPTION_KEYWORDS = [
  'assume', 'assuming', 'assumption',
  'suppose', 'supposing', 'suppose that',
  'we take', 'we consider',
  'for simplicity', 'in the limit',
  'neglect', 'ignoring', 'neglecting',
  'approximation', 'approximate',
  'treat as', 'treating',
];

// Keywords indicating implicit/inherited assumptions
const IMPLICIT_ASSUMPTION_PATTERNS = [
  'following ref', 'following \\[',
  'as in ref', 'as shown in',
  'using the method of', 'based on',
  'according to', 'from ref',
  'standard assumption', 'usual assumption',
  'it is well known', 'well-known',
];

// Keywords indicating challenges
const CHALLENGE_KEYWORDS = [
  'question', 'challenge', 'contradict',
  'inconsistent', 'disagree', 'dispute',
  'problematic', 'flaw', 'error',
  'invalid', 'violation', 'breaks down',
  'fails', 'failure', 'incorrect',
];

// Keywords indicating validation/support
const VALIDATION_KEYWORDS = [
  'confirm', 'validate', 'verify',
  'support', 'consistent with',
  'agreement', 'agrees with',
  'test', 'tested', 'demonstrated',
];

// Common assumption categories and examples
const ASSUMPTION_CATEGORIES: Record<string, string[]> = {
  theoretical: [
    'unitarity', 'causality', 'lorentz invariance',
    'gauge invariance', 'symmetry', 'perturbative',
    'non-perturbative', 'effective field theory',
    'standard model', 'supersymmetry',
  ],
  methodological: [
    'monte carlo', 'fitting', 'extrapolation',
    'interpolation', 'lattice', 'continuum limit',
    'chiral limit', 'perturbation theory',
    'resummation', 'factorization',
  ],
  experimental: [
    'detector', 'efficiency', 'background',
    'systematic', 'calibration', 'alignment',
    'trigger', 'acceptance', 'resolution',
  ],
  phenomenological: [
    'model', 'parametrization', 'form factor',
    'coupling', 'mixing', 'decay',
    'cross section', 'distribution',
  ],
};

// ─────────────────────────────────────────────────────────────────────────────
// Helper Functions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Extract sentences containing assumptions from text
 */
function extractAssumptionSentences(text: string): Array<{
  sentence: string;
  type: AssumptionType;
}> {
  const results: Array<{ sentence: string; type: AssumptionType }> = [];
  const sentences = text.split(/[.!?]+/).filter(s => s.trim().length > 20);

  for (const sentence of sentences) {
    const sentenceLower = sentence.toLowerCase();

    // Check for explicit assumptions
    if (EXPLICIT_ASSUMPTION_KEYWORDS.some(kw => sentenceLower.includes(kw))) {
      results.push({ sentence: sentence.trim(), type: 'explicit' });
      continue;
    }

    // Check for implicit/inherited assumptions
    if (IMPLICIT_ASSUMPTION_PATTERNS.some(p => sentenceLower.includes(p))) {
      results.push({ sentence: sentence.trim(), type: 'implicit' });
    }
  }

  return results;
}

/**
 * Categorize an assumption
 */
function categorizeAssumption(
  text: string
): 'theoretical' | 'methodological' | 'experimental' | 'phenomenological' {
  const textLower = text.toLowerCase();

  for (const [category, keywords] of Object.entries(ASSUMPTION_CATEGORIES)) {
    if (keywords.some(kw => textLower.includes(kw))) {
      return category as 'theoretical' | 'methodological' | 'experimental' | 'phenomenological';
    }
  }

  return 'theoretical'; // Default
}

/**
 * Check if a reference paper contains challenges to assumptions
 */
async function checkForChallenges(
  recid: string,
  _assumptionText: string
): Promise<Array<{ recid: string; title: string; }>> {
  const challenges: Array<{ recid: string; title: string; }> = [];

  try {
    // Prefer query-time filtering over scanning abstracts (we don't fetch abstracts in search fields).
    const keywordQuery = CHALLENGE_KEYWORDS
      .map(k => (k.includes(' ') ? `"${k}"` : k))
      .join(' or ');
    const query = `refersto:recid:${recid} and (${keywordQuery})`;
    const result = await api.search(query, { sort: 'mostrecent', size: 1000 });

    for (const paper of result.papers) {
      if (!paper.recid) continue;
      challenges.push({
        recid: paper.recid,
        title: paper.title,
      });
    }
  } catch (error) {
    // Log at debug level for troubleshooting
    console.debug(`[hep-research-mcp] searchChallenges (recid=${recid}): Skipped - ${error instanceof Error ? error.message : String(error)}`);
  }

  return challenges.slice(0, 3); // Limit to 3
}

/**
 * Check if references validate the assumption
 */
async function checkForValidation(
  recid: string,
  maxRefs: number = 10
): Promise<Array<{ recid: string; title: string; }>> {
  const validations: Array<{ recid: string; title: string; }> = [];

  try {
    const refs = await api.getReferences(recid, maxRefs);

    for (const ref of refs) {
      const title = ref.title || '';
      const titleLower = title.toLowerCase();

      // Check if title suggests validation
      if (VALIDATION_KEYWORDS.some(kw => titleLower.includes(kw))) {
        validations.push({
          recid: ref.recid || '',
          title: ref.title,
        });
      }
    }
  } catch (error) {
    // Log at debug level for troubleshooting
    console.debug(`[hep-research-mcp] checkValidations (recid=${recid}): Skipped - ${error instanceof Error ? error.message : String(error)}`);
    // Skip on error
  }

  return validations.slice(0, 3);
}

/**
 * Extract inherited assumptions from references
 */
async function extractInheritedAssumptions(
  recid: string,
  currentDepth: number,
  maxDepth: number
): Promise<AssumptionNode[]> {
  if (currentDepth >= maxDepth) return [];

  const inherited: AssumptionNode[] = [];
  const config = getConfig().criticalResearch;

  try {
    const refs = await api.getReferences(recid, config?.maxRefsPerLevel ?? 5);

    for (const ref of refs) {
      if (!ref.recid) continue;

      // Get reference paper details
      try {
        const paper = await api.getPaper(ref.recid);
        const abstract = paper.abstract || '';

        // Extract assumptions from reference abstract
        const refAssumptions = extractAssumptionSentences(abstract);
        const maxAssumptions = config?.maxAssumptionsPerRef ?? 2;

        for (const { sentence, type } of refAssumptions.slice(0, maxAssumptions)) {
          inherited.push({
            assumption: sentence,
            type,
            source: 'inherited',
            inherited_from: [{ recid: ref.recid, title: ref.title }],
            validation_status: 'untested', // Default for inherited
            category: categorizeAssumption(sentence),
          });
        }
      } catch (error) {
        // Log at debug level for troubleshooting
        console.debug(`[hep-research-mcp] extractInheritedAssumptions - ref processing (recid=${ref.recid}): Skipped - ${error instanceof Error ? error.message : String(error)}`);
        continue;
      }
    }
  } catch (error) {
    // Log at debug level for troubleshooting
    console.debug(`[hep-research-mcp] extractInheritedAssumptions (recid=${recid}): Skipped - ${error instanceof Error ? error.message : String(error)}`);
    // Skip on error
  }

  return inherited;
}

/**
 * Calculate fragility score based on assumptions
 */
function calculateFragilityScore(assumptions: AssumptionNode[]): number {
  if (assumptions.length === 0) return 0;

  let score = 0;
  let weight = 0;

  for (const assumption of assumptions) {
    const w = assumption.source === 'inherited' ? 1.2 : 1.0;
    weight += w;

    // Base fragility by validation status
    switch (assumption.validation_status) {
      case 'refuted':
        score += w * 1.0;
        break;
      case 'challenged':
        score += w * 0.7;
        break;
      case 'untested':
        score += w * 0.4;
        break;
      case 'tested':
        score += w * 0.1;
        break;
    }

    // Extra penalty for implicit assumptions
    if (assumption.type === 'implicit') {
      score += w * 0.1;
    }
  }

  return Math.min(1, score / weight);
}

/**
 * Identify critical dependencies (most fragile assumptions)
 */
function identifyCriticalDependencies(assumptions: AssumptionNode[]): string[] {
  const config = getConfig().criticalResearch;
  const maxDeps = config?.maxCriticalDependencies ?? 3;

  // Sort by fragility (challenged > untested > inherited)
  const sorted = [...assumptions].sort((a, b) => {
    const statusOrder: Record<ValidationStatus, number> = {
      refuted: 4,
      challenged: 3,
      untested: 2,
      tested: 1,
    };

    const aScore = statusOrder[a.validation_status] + (a.source === 'inherited' ? 0.5 : 0);
    const bScore = statusOrder[b.validation_status] + (b.source === 'inherited' ? 0.5 : 0);

    return bScore - aScore;
  });

  // Return top most critical
  return sorted.slice(0, maxDeps).map(a => a.assumption.slice(0, 100) + '...');
}

/**
 * Generate risk assessment
 */
function generateRiskAssessment(
  fragilityScore: number,
  challengedCount: number,
  untestedCount: number
): { level: 'low' | 'medium' | 'high'; description: string; recommendations: string[] } {
  let level: 'low' | 'medium' | 'high';
  let description: string;
  const recommendations: string[] = [];

  if (fragilityScore > 0.7 || challengedCount >= 2) {
    level = 'high';
    description = 'High fragility detected. Key assumptions have been challenged or are untested.';
    recommendations.push('Carefully verify all challenged assumptions before relying on conclusions');
    recommendations.push('Check cited papers for details on challenged assumptions');
    recommendations.push('Consider alternative approaches that avoid fragile assumptions');
  } else if (fragilityScore > 0.4 || challengedCount >= 1 || untestedCount >= 3) {
    level = 'medium';
    description = 'Moderate fragility. Some assumptions require attention.';
    recommendations.push('Review untested assumptions for potential weaknesses');
    recommendations.push('Look for independent validations of key assumptions');
  } else {
    level = 'low';
    description = 'Low fragility. Assumptions appear well-founded.';
    recommendations.push('Continue to monitor for new challenges in the literature');
  }

  return { level, description, recommendations };
}

// ─────────────────────────────────────────────────────────────────────────────
// Main Function
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Track assumptions and their validation status
 */
export async function trackAssumptions(
  params: AssumptionTrackerParams
): Promise<AssumptionTrackerResult> {
  const {
    recid,
    max_depth: rawMaxDepth = 2,
    check_challenges = true,
  } = params;

  // Validate recid
  const recidError = validateRecid(recid);
  if (recidError) {
    return {
      success: false,
      error: recidError,
      analysis: null,
    };
  }

  // Validate and clamp max_depth
  const max_depth = validateMaxDepth(rawMaxDepth, 2);

  try {
    // Get paper metadata
    const paper = await api.getPaper(recid);
    const abstract = paper.abstract || '';

    // Extract assumptions from abstract
    const directAssumptions = extractAssumptionSentences(abstract);
    const assumptions: AssumptionNode[] = [];

    // Process direct assumptions
    for (const { sentence, type } of directAssumptions) {
      const category = categorizeAssumption(sentence);

      let challenges: Array<{ recid: string; title: string; }> = [];
      let validations: Array<{ recid: string; title: string; }> = [];

      if (check_challenges) {
        challenges = await checkForChallenges(recid, sentence);
        validations = await checkForValidation(recid);
      }

      let validationStatus: ValidationStatus = 'untested';
      if (challenges.length > 0) {
        validationStatus = 'challenged';
      } else if (validations.length > 0) {
        validationStatus = 'tested';
      }

      assumptions.push({
        assumption: sentence,
        type,
        source: 'original',
        validation_status: validationStatus,
        challenge_papers: challenges.length > 0 ? challenges : undefined,
        supporting_papers: validations.length > 0 ? validations : undefined,
        category,
      });
    }

    // Extract inherited assumptions from references
    if (max_depth > 0) {
      const inherited = await extractInheritedAssumptions(recid, 0, max_depth);
      assumptions.push(...inherited);
    }

    // Calculate metrics
    const fragilityScore = calculateFragilityScore(assumptions);
    const criticalDependencies = identifyCriticalDependencies(assumptions);

    const explicitCount = assumptions.filter(a => a.type === 'explicit').length;
    const implicitCount = assumptions.filter(a => a.type === 'implicit').length;
    const inheritedCount = assumptions.filter(a => a.source === 'inherited').length;
    const challengedCount = assumptions.filter(a => a.validation_status === 'challenged').length;
    const untestedCount = assumptions.filter(a => a.validation_status === 'untested').length;

    const analysis: AssumptionChain = {
      paper_recid: recid,
      paper_title: paper.title,
      paper_year: paper.year,
      core_assumptions: assumptions,
      fragility_score: Math.round(fragilityScore * 100) / 100,
      critical_dependencies: criticalDependencies,
      summary: {
        total_assumptions: assumptions.length,
        explicit_count: explicitCount,
        implicit_count: implicitCount,
        inherited_count: inheritedCount,
        challenged_count: challengedCount,
        untested_count: untestedCount,
      },
    };

    const riskAssessment = generateRiskAssessment(
      fragilityScore,
      challengedCount,
      untestedCount
    );

    return {
      success: true,
      analysis,
      risk_assessment: riskAssessment,
    };

  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
      analysis: null,
    };
  }
}
