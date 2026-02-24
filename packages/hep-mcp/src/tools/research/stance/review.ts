/**
 * LLM Review Module (Phase 5)
 *
 * Generates structured review requests for complex stance cases.
 * Does NOT call LLM directly - returns requests for external callers.
 */

import * as crypto from 'crypto';
import type {
  CitationContextWithStance,
  LLMReviewRequest,
  LLMReviewTrigger,
} from './types.js';

// ─────────────────────────────────────────────────────────────────────────────
// Request ID Generation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Generate stable request ID using hash
 * Includes: targetRecid + sourceRecid + layer + normalizedTextHash
 */
export function generateRequestId(
  context: CitationContextWithStance,
  targetRecid: string,
  layer: 1 | 2 | 3,
  sourceRecid?: string
): string {
  const hash = crypto.createHash('sha1');
  hash.update(targetRecid);
  if (sourceRecid) hash.update(sourceRecid);
  hash.update(String(layer));

  // Normalize text for stable hash
  const normalized = context.context.extendedContext
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300);
  hash.update(normalized);

  return hash.digest('hex').slice(0, 16);
}

// ─────────────────────────────────────────────────────────────────────────────
// Priority Calculation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Calculate review priority (1-5)
 */
export function calculatePriority(
  context: CitationContextWithStance,
  triggers: LLMReviewTrigger[]
): number {
  let priority = 1;

  if (context.stance.confidence === 'low') priority += 1;
  if (context.stance.stance === 'mixed') priority += 2;
  if (context.stance.hasComplexNegation) priority += 1;
  if (triggers.includes('close_margin')) priority += 1;

  return Math.min(priority, 5);
}

// ─────────────────────────────────────────────────────────────────────────────
// Trigger Detection
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Detect which triggers apply to a context
 */
export function detectTriggers(
  context: CitationContextWithStance,
  aggregateSummary?: { confirming: number; contradicting: number }
): LLMReviewTrigger[] {
  const triggers: LLMReviewTrigger[] = [];

  // 1. Low confidence
  if (context.stance.confidence === 'low') {
    triggers.push('low_confidence');
  }

  // 2. Close margin (from aggregate)
  if (aggregateSummary) {
    const { confirming, contradicting } = aggregateSummary;
    const max = Math.max(confirming, contradicting);
    const min = Math.min(confirming, contradicting);
    if (max > 0 && min > 0 && max / min < 1.2) {
      triggers.push('close_margin');
    }
  }

  // 3. Complex negation
  if (context.stance.hasComplexNegation) {
    triggers.push('complex_negation');
  }

  // 4. Contrast flip detection
  // If stance is mixed and there's evidence of contrast markers
  if (context.stance.stance === 'mixed' && context.stance.mixedType === 'strong') {
    triggers.push('contrast_flip');
  }

  return triggers;
}

// ─────────────────────────────────────────────────────────────────────────────
// Prompt Generation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Generate suggested prompt for LLM review
 */
export function generateReviewPrompt(
  context: CitationContextWithStance
): string {
  return `Analyze the citation stance in the following context:

Context: "${context.context.extendedContext}"

Target paper is cited as: ${context.context.citekey}

Current analysis:
- Detected stance: ${context.stance.stance}
- Confidence: ${context.stance.confidence}
- Evidence: ${context.stance.evidenceSentences.join(' | ')}

Please determine:
1. The actual stance (confirming/contradicting/mixed/neutral)
2. Your confidence level (high/medium/low)
3. Brief reasoning

Format: JSON { "stance": "...", "confidence": "...", "reasoning": "..." }`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Main Functions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Create LLM review request for a single context
 */
export function createReviewRequest(
  context: CitationContextWithStance,
  targetRecid: string,
  options?: {
    layer?: 1 | 2 | 3;
    sourceRecid?: string;
    sourceTitle?: string;
    aggregateSummary?: { confirming: number; contradicting: number };
  }
): LLMReviewRequest | null {
  const layer = options?.layer ?? 1;
  const triggers = detectTriggers(context, options?.aggregateSummary);

  // Only create request if there are triggers
  if (triggers.length === 0) {
    return null;
  }

  const requestId = generateRequestId(
    context,
    targetRecid,
    layer,
    options?.sourceRecid
  );

  const priority = calculatePriority(context, triggers);
  const suggestedPrompt = generateReviewPrompt(context);

  const request: LLMReviewRequest = {
    requestId,
    context,
    reasons: triggers,
    suggestedPrompt,
    priority,
    layer,
  };

  // Add aggregate summary if close_margin triggered
  if (triggers.includes('close_margin') && options?.aggregateSummary) {
    const { confirming, contradicting } = options.aggregateSummary;
    request.aggregateSummary = {
      confirming,
      contradicting,
      topStance: confirming >= contradicting ? 'confirming' : 'contradicting',
      ratio: Math.max(confirming, contradicting) /
        Math.max(Math.min(confirming, contradicting), 0.1),
    };
  }

  // Add source metadata
  if (options?.sourceRecid || options?.sourceTitle) {
    request.sourceMeta = {
      sourceRecid: options.sourceRecid,
      sourceTitle: options.sourceTitle,
    };
  }

  return request;
}

/**
 * Filter contexts that need LLM review
 */
export function filterContextsNeedingReview(
  contexts: CitationContextWithStance[]
): CitationContextWithStance[] {
  return contexts.filter(ctx => ctx.stance.needsLLMReview);
}
