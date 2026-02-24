/**
 * Rao-Stirling Index for measuring paper interdisciplinarity
 *
 * The Rao-Stirling Index measures how diverse a paper's categories are,
 * weighted by the semantic distance between them.
 *
 * D_RS = Σ p_i * p_j * d_ij
 *
 * Higher scores indicate more interdisciplinary research.
 */

import { getDistance, isMatrixLoaded } from './distanceMatrix.js';
import { getConfig } from '../config.js';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type InterpretationType = 'standard' | 'bridge' | 'frontier';

export interface RaoStirlingResult {
  score: number;                    // 0-1, higher = more interdisciplinary
  categories: string[];
  pairDistances: {
    pair: [string, string];
    distance: number;
  }[];
  interpretation: InterpretationType;
  matrixLoaded: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Main Function
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Calculate Rao-Stirling Index for a set of categories
 *
 * @param categories - arXiv categories assigned to the paper
 * @param primaryCategory - Optional primary category (gets higher weight)
 */
export function calculateRaoStirling(
  categories: string[],
  primaryCategory?: string
): RaoStirlingResult {
  const config = getConfig();
  const bridgeThreshold = config.raoStirling?.bridgeThreshold ?? 0.3;
  const frontierThreshold = config.raoStirling?.frontierThreshold ?? 0.6;
  const primaryWeight = config.raoStirling?.primaryCategoryWeight ?? 0.5;

  // Handle edge cases
  if (categories.length === 0) {
    return {
      score: 0,
      categories: [],
      pairDistances: [],
      interpretation: 'standard',
      matrixLoaded: isMatrixLoaded(),
    };
  }

  if (categories.length === 1) {
    return {
      score: 0,
      categories,
      pairDistances: [],
      interpretation: 'standard',
      matrixLoaded: isMatrixLoaded(),
    };
  }

  // Calculate weights
  const weights: Record<string, number> = {};
  if (primaryCategory && categories.includes(primaryCategory)) {
    // Primary category gets higher weight
    const otherWeight = (1 - primaryWeight) / (categories.length - 1);
    categories.forEach(cat => {
      weights[cat] = cat === primaryCategory ? primaryWeight : otherWeight;
    });
  } else {
    // Uniform weights
    const uniformWeight = 1 / categories.length;
    categories.forEach(cat => {
      weights[cat] = uniformWeight;
    });
  }

  // Calculate Rao-Stirling Index
  let score = 0;
  const pairDistances: RaoStirlingResult['pairDistances'] = [];

  for (let i = 0; i < categories.length; i++) {
    for (let j = i + 1; j < categories.length; j++) {
      const catA = categories[i];
      const catB = categories[j];
      const distance = getDistance(catA, catB);

      // D_RS contribution: 2 * p_i * p_j * d_ij
      score += 2 * weights[catA] * weights[catB] * distance;

      pairDistances.push({
        pair: [catA, catB],
        distance,
      });
    }
  }

  // Determine interpretation
  let interpretation: InterpretationType = 'standard';
  if (score >= frontierThreshold) {
    interpretation = 'frontier';
  } else if (score >= bridgeThreshold) {
    interpretation = 'bridge';
  }

  return {
    score,
    categories,
    pairDistances,
    interpretation,
    matrixLoaded: isMatrixLoaded(),
  };
}
