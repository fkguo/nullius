/**
 * Stance Aggregator
 *
 * Aggregates multiple citation context stances into a single result.
 * Implements R3 aggregation rules with section weighting.
 */

import type {
  StanceType,
  ConfidenceLevel,
  AggregatedStance,
  CitationContextWithStance,
} from './types.js';

// ─────────────────────────────────────────────────────────────────────────────
// Section Weights
// ─────────────────────────────────────────────────────────────────────────────

const SECTION_WEIGHTS: Record<string, number> = {
  abstract: 1.5,
  introduction: 1.2,
  results: 1.3,
  discussion: 1.3,
  conclusion: 1.4,
  methods: 0.8,
  methodology: 0.8,
  references: 0.5,
  acknowledgments: 0.3,
};

/** Get section weight by name */
function getSectionWeightForAggregation(section?: string): number {
  if (!section) return 1.0;
  const lower = section.toLowerCase();
  for (const [key, weight] of Object.entries(SECTION_WEIGHTS)) {
    if (lower.includes(key)) return weight;
  }
  return 1.0;
}

// ─────────────────────────────────────────────────────────────────────────────
// Aggregation Rules (P1-7)
// ─────────────────────────────────────────────────────────────────────────────

const AGGREGATION_RULES = {
  // Confidence margin thresholds
  confidenceMargin: {
    high: 2.0,    // top > second * 2.0 => high
    medium: 1.3,  // top > second * 1.3 => medium
  },

  // Mixed detection thresholds
  mixedThreshold: {
    bothSignificant: 0.25,  // Both confirming and contradicting >= 25%
    mixedDominant: 0.4,     // Mixed score > 40%
  },

  // LLM review triggers
  reviewTriggers: {
    minSamples: 2,           // Sample count < 2
    marginTooSmall: 1.2,     // top/second < 1.2
    lowConfidenceRatio: 0.5, // Low confidence > 50%
    mixedRatio: 0.3,         // Mixed > 30%
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Main Aggregation Function
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Aggregate multiple stance results into a single result
 */
export function aggregateStances(
  contexts: CitationContextWithStance[]
): AggregatedStance {
  // Handle empty input
  if (contexts.length === 0) {
    return createEmptyAggregation();
  }

  // Calculate weighted scores and counts
  const scores = { confirming: 0, contradicting: 0, neutral: 0, mixed: 0 };
  const counts = { confirming: 0, contradicting: 0, neutral: 0, mixed: 0 };

  for (const { context, stance } of contexts) {
    const sectionWeight = getSectionWeightForAggregation(context.section);
    const confidenceWeight = stance.confidence === 'high' ? 1.5 : 1.0;

    counts[stance.stance]++;
    scores[stance.stance] += sectionWeight * confidenceWeight;
  }

  // Determine final stance and confidence
  const { stance, confidence, needsLLMReview, reviewReasons } =
    determineAggregatedStance(scores, counts, contexts);

  return { stance, confidence, scores, counts, needsLLMReview, reviewReasons };
}

/** Create empty aggregation result */
function createEmptyAggregation(): AggregatedStance {
  return {
    stance: 'neutral',
    confidence: 'low',
    scores: { confirming: 0, contradicting: 0, neutral: 0, mixed: 0 },
    counts: { confirming: 0, contradicting: 0, neutral: 0, mixed: 0 },
    needsLLMReview: true,
    reviewReasons: ['No citation contexts found'],
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Stance Determination Logic
// ─────────────────────────────────────────────────────────────────────────────

interface DeterminationResult {
  stance: StanceType;
  confidence: ConfidenceLevel;
  needsLLMReview: boolean;
  reviewReasons: string[];
}

/**
 * Determine aggregated stance from scores and counts
 */
function determineAggregatedStance(
  scores: Record<StanceType, number>,
  counts: Record<StanceType, number>,
  contexts: CitationContextWithStance[]
): DeterminationResult {
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  const totalScore = Object.values(scores).reduce((a, b) => a + b, 0);
  const reviewReasons: string[] = [];

  // Check sample count
  if (total < AGGREGATION_RULES.reviewTriggers.minSamples) {
    reviewReasons.push(`Too few samples (${total})`);
  }

  // Sort by score to find top and second
  const sorted = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  const [topStance, topScore] = sorted[0] as [StanceType, number];
  const secondScore = sorted[1]?.[1] || 0;

  // Check for mixed stance
  const confirmScore = scores.confirming || 0;
  const contradictScore = scores.contradicting || 0;
  const mixedScore = scores.mixed || 0;

  // Mixed detection: both confirming and contradicting are significant
  const bothSignificant = totalScore > 0 &&
    confirmScore / totalScore >= AGGREGATION_RULES.mixedThreshold.bothSignificant &&
    contradictScore / totalScore >= AGGREGATION_RULES.mixedThreshold.bothSignificant;

  // Mixed dominant
  const mixedDominant = totalScore > 0 &&
    mixedScore / totalScore >= AGGREGATION_RULES.mixedThreshold.mixedDominant;

  // Determine stance
  let stance: StanceType;
  if (bothSignificant || mixedDominant) {
    stance = 'mixed';
    reviewReasons.push('Mixed evidence detected');
  } else {
    stance = topStance;
  }

  // Determine confidence
  let confidence: ConfidenceLevel;
  const margin = secondScore > 0 ? topScore / secondScore : Infinity;

  if (margin >= AGGREGATION_RULES.confidenceMargin.high && topScore >= 2) {
    confidence = 'high';
  } else if (margin >= AGGREGATION_RULES.confidenceMargin.medium) {
    confidence = 'medium';
  } else {
    confidence = 'low';
  }

  // Check margin for review
  if (margin < AGGREGATION_RULES.reviewTriggers.marginTooSmall) {
    reviewReasons.push('Close margin between stances');
  }

  // Check low confidence ratio
  const lowConfCount = contexts.filter(c => c.stance.confidence === 'low').length;
  if (total > 0 && lowConfCount / total > AGGREGATION_RULES.reviewTriggers.lowConfidenceRatio) {
    reviewReasons.push('High ratio of low-confidence contexts');
  }

  // Check mixed ratio
  if (total > 0 && counts.mixed / total > AGGREGATION_RULES.reviewTriggers.mixedRatio) {
    reviewReasons.push('High ratio of mixed contexts');
  }

  return {
    stance,
    confidence,
    needsLLMReview: reviewReasons.length > 0,
    reviewReasons,
  };
}
