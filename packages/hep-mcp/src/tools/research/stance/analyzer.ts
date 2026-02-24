/**
 * Stance Analyzer
 *
 * Core stance detection logic with pattern matching, negation handling,
 * and ownership detection.
 */

import type {
  StanceType,
  ConfidenceLevel,
  OwnershipType,
  InputType,
  TargetBinding,
  StanceResult,
  SentenceStanceResult,
  MatchedRule,
  TextStanceOptions,
  SignificanceInfo,
} from './types.js';

import {
  CONFIRMING_PATTERNS,
  CONTRADICTING_PATTERNS,
  EXCEPTION_PATTERNS,
  HEDGE_PATTERNS,
  METHODOLOGICAL_PATTERNS,
  OWNERSHIP_MARKERS,
  EXPERIMENT_NAMES,
  CONTRAST_MARKERS,
  SIGMA_PATTERNS,
} from './patterns.js';

import { DEFAULT_STANCE_CONFIG, CONTRAST_CONFIG } from './config.js';
import { tokenize, isInNegationScope, splitIntoSentences } from './tokenizer.js';

// ─────────────────────────────────────────────────────────────────────────────
// Ownership Detection
// ─────────────────────────────────────────────────────────────────────────────

interface OwnershipScore {
  ours: number;
  theirs: number;
  label: OwnershipType;
}

/**
 * Detect ownership of a sentence (R3.4)
 */
export function detectOwnership(sentence: string, hasCite: boolean = false): OwnershipScore {
  let oursScore = 0;
  let theirsScore = hasCite ? 1 : 0; // Default bias towards theirs if has citation

  const lower = sentence.toLowerCase();

  // Ours signals
  for (const marker of OWNERSHIP_MARKERS.ours) {
    if (lower.includes(marker.toLowerCase())) {
      oursScore += 2;
    }
  }

  // Theirs signals
  for (const marker of OWNERSHIP_MARKERS.theirs) {
    if (lower.includes(marker.toLowerCase())) {
      theirsScore += 1;
    }
  }

  // Experiment names → theirs
  for (const exp of EXPERIMENT_NAMES) {
    if (sentence.includes(exp)) {
      theirsScore += 1;
    }
  }

  // Ref. pattern → strong theirs
  if (/\bRef\.?\s*\[/i.test(sentence)) {
    theirsScore += 2;
  }

  return {
    ours: oursScore,
    theirs: theirsScore,
    label: oursScore > theirsScore ? 'ours' : theirsScore > oursScore ? 'theirs' : 'unknown',
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Hedge Detection
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Detect hedge words and calculate downgrade
 */
export function detectHedges(text: string): { hedges: string[]; totalDowngrade: number } {
  const hedges: string[] = [];
  let totalDowngrade = 0;

  for (const { pattern, downgrade } of HEDGE_PATTERNS) {
    const match = text.match(pattern);
    if (match) {
      hedges.push(match[0]);
      totalDowngrade += downgrade;
    }
  }

  return { hedges, totalDowngrade: Math.min(totalDowngrade, 0.6) }; // Cap at 0.6
}

// ─────────────────────────────────────────────────────────────────────────────
// Statistical Significance Extraction
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Extract statistical significance from text
 */
export function extractSignificance(text: string): SignificanceInfo | undefined {
  for (const pattern of SIGMA_PATTERNS) {
    const match = text.match(pattern);
    if (match) {
      const value = parseFloat(match[1]);
      if (pattern.source.includes('%')) {
        return { confidenceLevel: value, raw: match[0] };
      } else {
        return { sigma: value, raw: match[0] };
      }
    }
  }
  return undefined;
}

// ─────────────────────────────────────────────────────────────────────────────
// Methodological Citation Check (R4.4, R5.5)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Check if citation is methodological (tool/method reference)
 */
export function isMethodologicalCitation(
  sentence: string,
  matchedRules: Array<{ weight: number }>
): boolean {
  const hasMethodPattern = METHODOLOGICAL_PATTERNS.some(p => p.test(sentence));
  // Protection: if has strong stance pattern, don't force neutral
  const hasStrongStance = matchedRules.some(r => r.weight >= 2);
  return hasMethodPattern && !hasStrongStance;
}

// ─────────────────────────────────────────────────────────────────────────────
// Contrast Detection
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Check if text is after a contrast marker
 */
export function isAfterContrast(text: string, position: number): boolean {
  const before = text.slice(0, position).toLowerCase();
  return CONTRAST_MARKERS.some(marker => {
    const idx = before.lastIndexOf(marker.toLowerCase());
    return idx !== -1 && position - idx < 50; // Within 50 chars
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Contrast Weight Application (Phase 5)
// ─────────────────────────────────────────────────────────────────────────────

/** Contrast analysis result */
export interface ContrastAnalysis {
  hasContrast: boolean;
  contrastIndex?: number;
  beforeStance: StanceType;
  afterStance: StanceType;
}

/**
 * Apply contrast weights to sentence scores
 * Sentences after contrast markers get higher weight
 * Sentences before contrast markers get lower weight
 */
export function applyContrastWeights(
  sentences: SentenceStanceResult[]
): SentenceStanceResult[] {
  if (!CONTRAST_CONFIG.enableContrastDetection) {
    return sentences;
  }

  return sentences.map((s, i) => {
    let factor = 1.0;

    // If this sentence is after a contrast marker, increase weight
    if (s.afterContrast) {
      factor = CONTRAST_CONFIG.afterContrastFactor;
    }

    // If next sentence is after contrast, decrease this sentence's weight
    if (i < sentences.length - 1 && sentences[i + 1].afterContrast) {
      factor = CONTRAST_CONFIG.beforeContrastFactor;
    }

    return {
      ...s,
      scoreConfirm: s.scoreConfirm * factor,
      scoreContra: s.scoreContra * factor,
    };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Pattern Matching
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Match patterns in text and return matched rules
 */
export function matchPatterns(
  text: string,
  tokens: string[]
): MatchedRule[] {
  const matched: MatchedRule[] = [];
  const matchedSnippets = new Set<string>(); // Track matched snippets to avoid duplicates

  // First check exception patterns (higher priority)
  for (const rule of EXCEPTION_PATTERNS) {
    const match = text.match(rule.pattern);
    if (match) {
      matchedSnippets.add(match[0].toLowerCase());
      matched.push({
        ruleId: rule.id,
        snippet: match[0],
        sentence: text,
        negated: false,
        hedged: rule.isHedge,
        weight: rule.weight,
        finalStance: rule.stance as StanceType,
      });
    }
  }

  // Check confirming patterns (skip if already matched by exception)
  for (const rule of CONFIRMING_PATTERNS) {
    const match = text.match(rule.pattern);
    if (match && !matchedSnippets.has(match[0].toLowerCase())) {
      const tokenIdx = findTokenIndex(tokens, match[0]);
      const negation = rule.negatable ? isInNegationScope(tokens, tokenIdx) : { negated: false };

      let finalStance: StanceType = 'confirming';
      if (negation.negated && rule.negatable) {
        finalStance = rule.negationBehavior === 'flip' ? 'contradicting' :
                      rule.negationBehavior === 'neutral' ? 'neutral' : 'confirming';
      }

      matched.push({
        ruleId: rule.id,
        snippet: match[0],
        sentence: text,
        negated: negation.negated,
        weight: rule.weight,
        finalStance,
      });
    }
  }

  // Check contradicting patterns (skip if already matched by exception)
  for (const rule of CONTRADICTING_PATTERNS) {
    const match = text.match(rule.pattern);
    if (match && !matchedSnippets.has(match[0].toLowerCase())) {
      const tokenIdx = findTokenIndex(tokens, match[0]);
      const negation = rule.negatable ? isInNegationScope(tokens, tokenIdx) : { negated: false };

      let finalStance: StanceType = 'contradicting';
      if (negation.negated && rule.negatable) {
        finalStance = rule.negationBehavior === 'flip' ? 'confirming' :
                      rule.negationBehavior === 'neutral' ? 'neutral' :
                      rule.negationBehavior === 'weak_confirm' ? 'confirming' : 'contradicting';
      }

      matched.push({
        ruleId: rule.id,
        snippet: match[0],
        sentence: text,
        negated: negation.negated,
        weight: rule.weight,
        finalStance,
      });
    }
  }

  return matched;
}

/** Find token index for a matched snippet */
function findTokenIndex(tokens: string[], snippet: string): number {
  const snippetLower = snippet.toLowerCase();
  const snippetTokens = snippetLower.split(/\s+/);
  const firstToken = snippetTokens[0];
  return tokens.findIndex(t => t === firstToken);
}

// ─────────────────────────────────────────────────────────────────────────────
// Sentence Analysis
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Analyze a single sentence for stance
 */
export function analyzeSentence(
  sentence: string,
  index: number,
  fullText: string
): SentenceStanceResult {
  const tokens = tokenize(sentence);
  const matched = matchPatterns(sentence, tokens);
  const ownership = detectOwnership(sentence, sentence.includes('Ref') || sentence.includes('cite'));
  const { hedges: _hedges, totalDowngrade } = detectHedges(sentence);
  const significance = extractSignificance(sentence);

  // Calculate scores
  let scoreConfirm = 0;
  let scoreContra = 0;

  for (const rule of matched) {
    if (rule.finalStance === 'confirming') {
      scoreConfirm += rule.weight;
    } else if (rule.finalStance === 'contradicting') {
      scoreContra += rule.weight;
    }
  }

  // Check if after contrast marker
  const sentenceStart = fullText.indexOf(sentence);
  const afterContrast = sentenceStart > 0 && isAfterContrast(fullText, sentenceStart);

  return {
    sentence,
    index,
    ownership: ownership.label,
    afterContrast,
    matchedRules: matched.map(m => ({
      ruleId: m.ruleId,
      snippet: m.snippet,
      negated: m.negated,
      hedged: m.hedged || false,
    })),
    scoreConfirm,
    scoreContra,
    scoreHedge: totalDowngrade,
    significance,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// LLM Review Score (R2.3)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Calculate LLM review score
 */
export function calculateReviewScore(
  stance: StanceType,
  layerUsed: 1 | 2 | 3,
  targetBinding: TargetBinding,
  ownership: OwnershipType,
  hasComplexNegation: boolean,
  isMultiCite: boolean
): number {
  let score = 0;

  if (stance === 'mixed') score += 3;
  if (targetBinding === 'neighbor_sentence') score += 1;
  if (layerUsed === 3) score += 2;
  if (ownership === 'unknown') score += 1;
  if (hasComplexNegation) score += 1;
  if (isMultiCite && stance === 'contradicting') score += 1;

  return score;
}

// ─────────────────────────────────────────────────────────────────────────────
// Main Analysis Function (R3.8)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Analyze text for stance (low-level API)
 * Pure text analysis, easy to unit test
 */
export function analyzeTextStance(
  text: string,
  opts?: TextStanceOptions
): StanceResult {
  if (!text || text.length === 0) {
    return createEmptyResult(opts?.inputType || 'abstract');
  }

  const sentences = splitIntoSentences(text);
  const sentenceResults: SentenceStanceResult[] = [];

  // Analyze each sentence
  for (let i = 0; i < sentences.length; i++) {
    const result = analyzeSentence(sentences[i], i, text);
    sentenceResults.push(result);
  }

  // Aggregate results
  return aggregateResults(sentenceResults, text, opts);
}

/** Create empty result for invalid input */
function createEmptyResult(inputType: InputType): StanceResult {
  return {
    stance: 'neutral',
    confidence: 'low',
    needsLLMReview: true,
    llmReviewReason: 'Empty or invalid input',
    scoreConfirm: 0,
    scoreContra: 0,
    hedges: [],
    matched: [],
    evidenceSentences: [],
    analyzedSentenceCount: 0,
    inputType,
    isWeakSignal: true,
    layerUsed: 3,
    targetBinding: 'paragraph',
    reviewScore: 2,
  };
}

/** Aggregate sentence results into final stance */
function aggregateResults(
  sentenceResults: SentenceStanceResult[],
  _text: string,
  opts?: TextStanceOptions
): StanceResult {
  const inputType = opts?.inputType || 'abstract';
  const isWeakSignal = opts?.forceWeakSignal || inputType === 'abstract';

  // Collect all matched rules and hedges
  const allMatched: MatchedRule[] = [];
  const allHedges: string[] = [];
  let totalConfirm = 0;
  let totalContra = 0;
  let totalHedge = 0;

  for (const sr of sentenceResults) {
    totalConfirm += sr.scoreConfirm;
    totalContra += sr.scoreContra;
    totalHedge += sr.scoreHedge;

    for (const rule of sr.matchedRules) {
      allMatched.push({
        ruleId: rule.ruleId,
        snippet: rule.snippet,
        sentence: sr.sentence,
        negated: rule.negated,
        hedged: rule.hedged,
        weight: 1,
        finalStance: 'neutral',
      });
    }
  }

  // Determine stance
  const { stance, mixedType } = determineStance(totalConfirm, totalContra, sentenceResults);

  // Determine confidence
  const confidence = determineConfidence(totalConfirm, totalContra, totalHedge, allMatched.length);

  // Calculate review score
  const dominantOwnership = getDominantOwnership(sentenceResults);
  const hasComplexNegation = allMatched.some(m => m.negated);
  const reviewScore = calculateReviewScore(
    stance, 3, 'paragraph', dominantOwnership, hasComplexNegation, false
  );

  return {
    stance,
    confidence,
    needsLLMReview: reviewScore >= DEFAULT_STANCE_CONFIG.llmReviewScoreThreshold,
    llmReviewReason: reviewScore >= 2 ? getReviewReason(reviewScore, stance, dominantOwnership) : undefined,
    scoreConfirm: totalConfirm,
    scoreContra: totalContra,
    hedges: allHedges,
    matched: allMatched,
    evidenceSentences: sentenceResults.filter(s => s.scoreConfirm > 0 || s.scoreContra > 0).map(s => s.sentence),
    analyzedSentenceCount: sentenceResults.length,
    inputType,
    isWeakSignal,
    layerUsed: 3,
    targetBinding: 'paragraph',
    reviewScore,
    mixedType,
    hasComplexNegation,
    ownershipScore: { ours: 0, theirs: 0 },
  };
}

/** Determine stance from scores (R4.2) */
function determineStance(
  totalConfirm: number,
  totalContra: number,
  sentenceResults: SentenceStanceResult[]
): { stance: StanceType; mixedType?: 'strong' | 'weak' } {
  const threshold = DEFAULT_STANCE_CONFIG.mixedThreshold;

  // Check for strong mixed (both have weight>=2 rules)
  const hasStrongConfirm = sentenceResults.some(sr =>
    sr.matchedRules.some(r => r.ruleId.startsWith('confirm') && !r.negated)
  );
  const hasStrongContra = sentenceResults.some(sr =>
    sr.matchedRules.some(r => r.ruleId.startsWith('contra') && !r.negated)
  );

  if (hasStrongConfirm && hasStrongContra) {
    return { stance: 'mixed', mixedType: 'strong' };
  }

  // Check for weak mixed
  const margin = Math.abs(totalConfirm - totalContra);
  if (margin < threshold && totalConfirm > 0 && totalContra > 0) {
    return { stance: 'mixed', mixedType: 'weak' };
  }

  // Normal determination
  if (totalConfirm > totalContra) return { stance: 'confirming' };
  if (totalContra > totalConfirm) return { stance: 'contradicting' };
  return { stance: 'neutral' };
}

/** Determine confidence level */
function determineConfidence(
  totalConfirm: number,
  totalContra: number,
  totalHedge: number,
  _matchCount: number
): ConfidenceLevel {
  const maxScore = Math.max(totalConfirm, totalContra);
  const margin = Math.abs(totalConfirm - totalContra);

  if (maxScore >= 3 && margin >= 2 && totalHedge < 0.3) return 'high';
  if (maxScore >= 1 && margin >= 1) return 'medium';
  return 'low';
}

/** Get dominant ownership from sentence results */
function getDominantOwnership(results: SentenceStanceResult[]): OwnershipType {
  let ours = 0, theirs = 0;
  for (const r of results) {
    if (r.ownership === 'ours') ours++;
    else if (r.ownership === 'theirs') theirs++;
  }
  if (ours > theirs) return 'ours';
  if (theirs > ours) return 'theirs';
  return 'unknown';
}

/** Get review reason */
function getReviewReason(score: number, stance: StanceType, ownership: OwnershipType): string {
  const reasons: string[] = [];
  if (stance === 'mixed') reasons.push('mixed evidence');
  if (ownership === 'unknown') reasons.push('unclear ownership');
  if (score >= 3) reasons.push('low confidence');
  return reasons.join(', ') || 'needs verification';
}
