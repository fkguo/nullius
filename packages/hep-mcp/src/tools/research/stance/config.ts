/**
 * Stance Detection Configuration
 *
 * Configurable parameters for the stance detection system.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Stance Detection Configuration
// ─────────────────────────────────────────────────────────────────────────────

export interface StanceConfig {
  // Thresholds
  /** Threshold for mixed stance detection (default: 1.5) */
  mixedThreshold: number;
  /** LLM review score threshold (default: 2) */
  llmReviewScoreThreshold: number;

  // Negation
  /** Negation scope window size in tokens (default: 8) */
  negationWindowSize: number;
}

/** Default configuration */
export const DEFAULT_STANCE_CONFIG: StanceConfig = {
  // Thresholds
  mixedThreshold: 1.5,
  llmReviewScoreThreshold: 2,

  // Negation
  negationWindowSize: 8,
};

// ─────────────────────────────────────────────────────────────────────────────
// Section Weights
// ─────────────────────────────────────────────────────────────────────────────

/** Get section weight based on section name */
export function getSectionWeight(sectionName: string): number {
  const lower = sectionName.toLowerCase();
  if (/comparison|discussion/.test(lower)) return 1.5;
  if (/conclusion|summary|outlook/.test(lower)) return 1.5;
  if (/result/.test(lower)) return 1.3;
  if (/introduction|background/.test(lower)) return 0.8;
  if (/method|technique|apparatus|data|sample/.test(lower)) return 0.5;
  if (/acknowledg/.test(lower)) return 0;
  return 1.0;
}

// ─────────────────────────────────────────────────────────────────────────────
// Binding Weights
// ─────────────────────────────────────────────────────────────────────────────

import type { TargetBinding } from './types.js';

/** Get binding weight based on target binding type */
export function getBindingWeight(binding: TargetBinding): number {
  switch (binding) {
    case 'same_sentence': return 1.0;
    case 'neighbor_sentence': return 0.7;
    case 'paragraph': return 0.4;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Ownership Weights
// ─────────────────────────────────────────────────────────────────────────────

import type { OwnershipType } from './types.js';

/** Get ownership weight */
export function getOwnershipWeight(ownership: OwnershipType): number {
  switch (ownership) {
    case 'ours': return 0.5;    // Our results - less weight for stance
    case 'theirs': return 1.0;  // Their results - full weight
    case 'unknown': return 0.8; // Unknown - moderate weight
  }
}

/** Get self-citation weight */
export function getSelfCitationWeight(isSelfCitation: boolean): number {
  return isSelfCitation ? 0.5 : 1.0;
}

// ─────────────────────────────────────────────────────────────────────────────
// Contrast Detection Configuration (Phase 5)
// ─────────────────────────────────────────────────────────────────────────────

/** Contrast marker detection configuration */
export const CONTRAST_CONFIG = {
  // Weight factor for sentences after contrast markers
  afterContrastFactor: 1.5,
  // Weight factor for sentences before contrast markers (downweight)
  beforeContrastFactor: 0.7,
  // Enable contrast detection
  enableContrastDetection: true,
};
