/**
 * Review Classifier Module
 * Classifies review papers into types and assesses their authority
 *
 * Types:
 * - Catalog: Lists papers without strong opinions
 * - Critical: Argues a specific viewpoint
 * - Consensus: Community reports (PDG, Snowmass, etc.)
 */

import * as api from '../../api/client.js';
import { validateRecids } from './config.js';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type ReviewType = 'catalog' | 'critical' | 'consensus';
export type CoverageScope = 'narrow' | 'moderate' | 'comprehensive';
export type Recency = 'current' | 'dated' | 'historical';

export interface ReviewClassification {
  recid: string;
  title: string;
  /** Type of review */
  review_type: ReviewType;
  /** Authority score (0-1) */
  authority_score: number;
  /** Coverage indicators */
  coverage: {
    /** Estimated number of papers covered */
    paper_count: number;
    /** Topic breadth */
    scope: CoverageScope;
    /** Author diversity in the review */
    author_diversity: 'single_group' | 'multi_group' | 'community';
  };
  /** Potential biases detected */
  potential_biases: string[];
  /** Recency assessment */
  recency: Recency;
  /** Years since publication */
  age_years: number;
  /** Whether this is from a known authoritative source */
  is_authoritative_source: boolean;
  /** Confidence in classification */
  classification_confidence: 'high' | 'medium' | 'low';
}

export interface ClassifyReviewsParams {
  /** INSPIRE recids of papers to classify */
  recids: string[];
  /** Year threshold for "current" (default: 3 years) */
  current_threshold_years?: number;
}

export interface ClassifyReviewsResult {
  success: boolean;
  error?: string;
  /** Classified reviews */
  classifications: ReviewClassification[];
  /** Summary statistics */
  summary: {
    total: number;
    by_type: Record<ReviewType, number>;
    authoritative_count: number;
    average_authority_score: number;
  };
  /** Recommendation for which reviews to trust */
  recommendation?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

// Keywords indicating consensus/community reports
const CONSENSUS_KEYWORDS = [
  'pdg', 'particle data group', 'review of particle physics',
  'snowmass', 'white paper', 'community report',
  'european strategy', 'p5 report', 'decadal survey',
  'working group', 'task force', 'committee',
  'lhc higgs cross section', 'flavour lattice averaging group', 'flag',
  'heavy flavor averaging group', 'hflav',
];

// Known authoritative collaborations/groups for consensus
const AUTHORITATIVE_SOURCES = [
  'particle data group', 'pdg',
  'flag', 'flavour lattice',
  'hflav', 'heavy flavor',
  'lhc higgs', 'lhc top',
  'snowmass', 'european strategy',
];

// Keywords indicating critical/argumentative reviews
const CRITICAL_KEYWORDS = [
  'argue', 'claim', 'controversy', 'debate',
  'challenge', 'question', 'critique', 'critical',
  'alternative', 'disagree', 'tension',
  'we show', 'we demonstrate', 'we argue',
  'in contrast', 'however', 'on the other hand',
];

// Keywords indicating catalog-style reviews
const CATALOG_KEYWORDS = [
  'survey', 'collection', 'compilation',
  'catalog', 'list', 'summary',
  'overview', 'introduction to', 'primer',
];

// ─────────────────────────────────────────────────────────────────────────────
// Helper Functions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Check if paper is from an authoritative source
 */
function isAuthoritativeSource(title: string, authors: string[]): boolean {
  const titleLower = title.toLowerCase();
  const authorsStr = authors.join(' ').toLowerCase();

  for (const source of AUTHORITATIVE_SOURCES) {
    if (titleLower.includes(source) || authorsStr.includes(source)) {
      return true;
    }
  }

  return false;
}

/**
 * Classify review type based on content
 */
function classifyReviewType(
  title: string,
  abstract: string,
  authorCount: number
): { type: ReviewType; confidence: 'high' | 'medium' | 'low' } {
  const text = `${title} ${abstract}`.toLowerCase();

  // Check for consensus indicators first (highest priority)
  let consensusScore = 0;
  for (const keyword of CONSENSUS_KEYWORDS) {
    if (text.includes(keyword)) {
      consensusScore++;
    }
  }

  // Large author count suggests consensus
  if (authorCount > 20) {
    consensusScore += 2;
  }

  if (consensusScore >= 2) {
    return { type: 'consensus', confidence: 'high' };
  }

  // Check for critical indicators
  let criticalScore = 0;
  for (const keyword of CRITICAL_KEYWORDS) {
    if (text.includes(keyword)) {
      criticalScore++;
    }
  }

  if (criticalScore >= 3) {
    return { type: 'critical', confidence: 'high' };
  }

  if (criticalScore >= 1) {
    return { type: 'critical', confidence: 'medium' };
  }

  // Check for catalog indicators
  let catalogScore = 0;
  for (const keyword of CATALOG_KEYWORDS) {
    if (text.includes(keyword)) {
      catalogScore++;
    }
  }

  if (catalogScore >= 2) {
    return { type: 'catalog', confidence: 'high' };
  }

  if (catalogScore >= 1) {
    return { type: 'catalog', confidence: 'medium' };
  }

  // Default to catalog with low confidence
  return { type: 'catalog', confidence: 'low' };
}

/**
 * Estimate coverage scope from abstract
 */
function estimateCoverageScope(abstract: string): CoverageScope {
  const abstractLower = abstract.toLowerCase();

  // Comprehensive indicators
  const comprehensiveWords = [
    'comprehensive', 'complete', 'thorough', 'exhaustive',
    'all aspects', 'full coverage', 'state of the art',
  ];

  for (const word of comprehensiveWords) {
    if (abstractLower.includes(word)) {
      return 'comprehensive';
    }
  }

  // Narrow indicators
  const narrowWords = [
    'specific', 'particular', 'focus on', 'limited to',
    'selected', 'subset', 'brief',
  ];

  for (const word of narrowWords) {
    if (abstractLower.includes(word)) {
      return 'narrow';
    }
  }

  return 'moderate';
}

/**
 * Estimate author diversity
 */
function estimateAuthorDiversity(authorCount: number): 'single_group' | 'multi_group' | 'community' {
  if (authorCount >= 20) return 'community';
  if (authorCount >= 5) return 'multi_group';
  return 'single_group';
}

/**
 * Detect potential biases in review
 */
function detectPotentialBiases(
  title: string,
  abstract: string,
  authors: string[],
  authorCount: number
): string[] {
  const biases: string[] = [];
  const text = `${title} ${abstract}`.toLowerCase();

  // Single author bias
  if (authorCount === 1) {
    biases.push('Single author - may reflect personal viewpoint');
  }

  // Small author team for comprehensive review
  if (authorCount >= 2 && authorCount <= 3) {
    const comprehensiveWords = ['comprehensive', 'complete', 'thorough', 'exhaustive'];
    if (comprehensiveWords.some(w => text.includes(w))) {
      biases.push('Small author team for claimed comprehensive review');
    }
  }

  // Self-promotion indicators
  const selfPromoWords = ['our work', 'our group', 'our method', 'our approach'];
  if (selfPromoWords.some(w => text.includes(w))) {
    biases.push('Contains self-referential language');
  }

  // Strong opinion indicators
  const opinionWords = ['best', 'only', 'correct', 'wrong', 'superior', 'inferior'];
  const opinionCount = opinionWords.filter(w => text.includes(w)).length;
  if (opinionCount >= 2) {
    biases.push('Uses evaluative language suggesting strong opinions');
  }

  // Check for specific theory/model promotion
  const theoryPromotion = text.match(/(?:our|the)\s+(\w+)\s+model/gi);
  if (theoryPromotion && theoryPromotion.length > 0) {
    biases.push('May promote specific theoretical framework');
  }

  // Author concentration check - look for surname repetition (family/group bias)
  if (authors.length >= 2) {
    const surnames = authors.map(a => {
      // Extract surname (last word in name, or part after comma)
      const parts = a.includes(',') ? a.split(',')[0].trim() : a.split(' ').pop();
      return (parts || '').toLowerCase();
    }).filter(s => s.length > 2);

    // Count surname occurrences
    const surnameCounts = new Map<string, number>();
    for (const surname of surnames) {
      surnameCounts.set(surname, (surnameCounts.get(surname) || 0) + 1);
    }

    // Check for repeated surnames (possible family/close group)
    const repeatedSurnames = [...surnameCounts.entries()].filter(([, count]) => count >= 2);
    if (repeatedSurnames.length > 0 && authors.length <= 5) {
      biases.push('Author group may have close collaboration ties (shared surnames)');
    }
  }

  // Check if abstract mentions specific collaboration/institution heavily
  const institutionMentions = text.match(/\b(our collaboration|our experiment|our group|our institute)\b/gi);
  if (institutionMentions && institutionMentions.length >= 2) {
    biases.push('Heavy focus on single collaboration/institution');
  }

  return biases;
}

/**
 * Calculate authority score
 */
function calculateAuthorityScore(
  reviewType: ReviewType,
  citationCount: number,
  authorCount: number,
  isAuthoritative: boolean,
  biasCount: number,
  ageYears: number
): number {
  let score = 0.5; // Base score

  // Type-based scoring
  if (reviewType === 'consensus') {
    score += 0.3;
  } else if (reviewType === 'critical') {
    score += 0.1;
  }

  // Authoritative source bonus
  if (isAuthoritative) {
    score += 0.2;
  }

  // Citation-based scoring (normalized)
  if (citationCount > 1000) {
    score += 0.15;
  } else if (citationCount > 500) {
    score += 0.1;
  } else if (citationCount > 100) {
    score += 0.05;
  }

  // Author diversity bonus for consensus
  if (reviewType === 'consensus' && authorCount > 20) {
    score += 0.1;
  }

  // Bias penalty
  score -= biasCount * 0.05;

  // Age penalty for old non-consensus reviews
  if (reviewType !== 'consensus' && ageYears > 10) {
    score -= 0.1;
  }

  return Math.max(0, Math.min(1, score));
}

/**
 * Determine recency
 */
function determineRecency(ageYears: number, threshold: number): Recency {
  if (ageYears <= threshold) return 'current';
  if (ageYears <= threshold * 3) return 'dated';
  return 'historical';
}

/**
 * Estimate paper count covered by review
 */
async function estimatePaperCount(recid: string): Promise<number> {
  try {
    const refs = await api.getReferences(recid);
    return refs.length;
  } catch (error) {
    // Log at debug level for troubleshooting
    console.debug(`[hep-research-mcp] estimatePaperCount (recid=${recid}): Skipped - ${error instanceof Error ? error.message : String(error)}`);
    return 0;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Main Function
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Classify review papers
 */
export async function classifyReviews(
  params: ClassifyReviewsParams
): Promise<ClassifyReviewsResult> {
  const {
    recids,
    current_threshold_years = 3,
  } = params;

  // Validate recids
  const validationError = validateRecids(recids);
  if (validationError) {
    return {
      success: false,
      error: validationError,
      classifications: [],
      summary: {
        total: 0,
        by_type: { catalog: 0, critical: 0, consensus: 0 },
        authoritative_count: 0,
        average_authority_score: 0,
      },
    };
  }

  const currentYear = new Date().getFullYear();

  // Fetch all papers in parallel for better performance
  const fetchPromises = recids.map(async (recid): Promise<ReviewClassification | null> => {
    try {
      // Fetch paper metadata and reference count in parallel
      const [paper, paperCount] = await Promise.all([
        api.getPaper(recid),
        estimatePaperCount(recid),
      ]);

      const authors = paper.authors || [];
      const authorCount = paper.author_count ?? authors.length;
      const ageYears = currentYear - (paper.year || currentYear);

      // Check if authoritative source
      const isAuthoritative = isAuthoritativeSource(paper.title, authors);

      // Classify review type
      const { type: reviewType, confidence } = classifyReviewType(
        paper.title,
        paper.abstract || '',
        authorCount
      );

      // Detect biases
      const biases = detectPotentialBiases(
        paper.title,
        paper.abstract || '',
        authors,
        authorCount
      );

      // Calculate authority score
      const authorityScore = calculateAuthorityScore(
        reviewType,
        paper.citation_count || 0,
        authorCount,
        isAuthoritative,
        biases.length,
        ageYears
      );

      return {
        recid,
        title: paper.title,
        review_type: reviewType,
        authority_score: Math.round(authorityScore * 100) / 100,
        coverage: {
          paper_count: paperCount,
          scope: estimateCoverageScope(paper.abstract || ''),
          author_diversity: estimateAuthorDiversity(authorCount),
        },
        potential_biases: biases,
        recency: determineRecency(ageYears, current_threshold_years),
        age_years: ageYears,
        is_authoritative_source: isAuthoritative,
        classification_confidence: confidence,
      };
    } catch (error) {
      // Log at debug level for troubleshooting
      console.debug(`[hep-research-mcp] classifyReviews (recid=${recid}): Skipped - ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  });

  // Wait for all parallel fetches
  const results = await Promise.all(fetchPromises);

  // Filter out failed fetches
  const classifications = results.filter((c): c is ReviewClassification => c !== null);

  // Calculate summary
  const byType: Record<ReviewType, number> = { catalog: 0, critical: 0, consensus: 0 };
  let authoritySum = 0;
  let authoritativeCount = 0;

  for (const c of classifications) {
    byType[c.review_type]++;
    authoritySum += c.authority_score;
    if (c.is_authoritative_source) {
      authoritativeCount++;
    }
  }

  const averageAuthority = classifications.length > 0
    ? authoritySum / classifications.length
    : 0;

  // Generate recommendation
  let recommendation: string | undefined;
  if (classifications.length > 0) {
    const consensus = classifications.filter(c => c.review_type === 'consensus');
    const highAuthority = classifications.filter(c => c.authority_score >= 0.7);
    const current = classifications.filter(c => c.recency === 'current');

    if (consensus.length > 0) {
      recommendation = `Prefer consensus reviews (${consensus.length} found) for authoritative baseline. `;
    }

    if (highAuthority.length > 0 && consensus.length === 0) {
      recommendation = (recommendation || '') + `High authority reviews (${highAuthority.length}) provide reliable coverage. `;
    }

    if (current.length === 0) {
      recommendation = (recommendation || '') + 'Warning: No current reviews found; field may have evolved.';
    }
  }

  return {
    success: true,
    classifications,
    summary: {
      total: classifications.length,
      by_type: byType,
      authoritative_count: authoritativeCount,
      average_authority_score: Math.round(averageAuthority * 100) / 100,
    },
    recommendation,
  };
}
