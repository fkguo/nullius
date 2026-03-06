import { cleanMathML } from '../../tools/research/preprocess/utils.js';
import { DEFAULT_CRITICAL_RESEARCH_CONFIG, DEFAULT_STANCE_DETECTION, getConfig } from '../../tools/research/config.js';
import type { CitationStance, ConfidenceLevel, EvidenceLevel } from './claimTypes.js';

const CLAIM_KEYWORDS = ['discover', 'observe', 'measure', 'find', 'detect', 'evidence', 'show', 'confirm', 'report', 'identify', 'constrain', 'determine'];
const THEORETICAL_KEYWORDS = ['predict', 'theoretical', 'model', 'suggest', 'imply', 'consistent with', 'expect', 'calculate'];
const HINT_KEYWORDS = ['hint', 'possible', 'potential', 'tentative', 'preliminary', 'indication', 'excess', 'anomaly'];
const SIGMA_PATTERNS = [/(-?\d+\.?\d*)\s*[σ\\sigma]/i, /(-?\d+\.?\d*)\s*sigma/i, /significance\s+of\s+(-?\d+\.?\d*)/i];
const STANCE_PATTERNS = {
  confirming: DEFAULT_STANCE_DETECTION.confirmingPatterns,
  contradicting: DEFAULT_STANCE_DETECTION.contradictingPatterns,
} as const;
const NEGATION_WORDS = DEFAULT_STANCE_DETECTION.negationWords;

export interface StanceResult {
  stance: CitationStance;
  confidence: 'high' | 'medium' | 'low';
  matched_pattern?: string;
  needs_llm_review?: boolean;
}

function hasNegationBefore(text: string, patternIndex: number): boolean {
  const context = text.slice(Math.max(0, patternIndex - 15), patternIndex);
  return NEGATION_WORDS.some(word => context.includes(word));
}

function findRelevantContextWindows(text: string, claimKeywords: string[]): string[] {
  const windows: string[] = [];
  const windowSize = DEFAULT_STANCE_DETECTION.contextWindowSize;
  for (const keyword of claimKeywords) {
    let index = 0;
    while ((index = text.indexOf(keyword.toLowerCase(), index)) !== -1) {
      windows.push(text.slice(Math.max(0, index - windowSize), Math.min(text.length, index + keyword.length + windowSize)));
      index += keyword.length;
    }
  }
  return windows;
}

export function analyzeCitationStance(abstract: string, claimKeywords: string[]): StanceResult {
  if (!abstract) return { stance: 'neutral', confidence: 'low', needs_llm_review: true };
  const lowered = abstract.toLowerCase();
  const windows = findRelevantContextWindows(lowered, claimKeywords);
  const texts = windows.length > 0 ? windows : [lowered];
  const confidence = windows.length > 0 ? 'high' : 'medium';

  for (const text of texts) {
    for (const pattern of STANCE_PATTERNS.contradicting) {
      const index = text.indexOf(pattern);
      if (index === -1) continue;
      if (hasNegationBefore(text, index)) return { stance: 'confirming', confidence, matched_pattern: `NOT ${pattern}` };
      return { stance: 'contradicting', confidence, matched_pattern: pattern };
    }
    for (const pattern of STANCE_PATTERNS.confirming) {
      const index = text.indexOf(pattern);
      if (index === -1) continue;
      if (hasNegationBefore(text, index)) return { stance: 'contradicting', confidence, matched_pattern: `NOT ${pattern}` };
      return { stance: 'confirming', confidence, matched_pattern: pattern };
    }
  }

  return { stance: 'neutral', confidence: 'low', needs_llm_review: true };
}

export function extractTopicWords(claim: string): string[] {
  const stopWords = new Set(['the', 'and', 'for', 'with', 'from', 'this', 'that', 'these', 'those', 'show', 'find', 'found', 'measure', 'observe', 'discover', 'result']);
  return claim.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(word => word.length > 2 && !stopWords.has(word)).slice(0, 6);
}

export function extractSigmaLevel(text: string): number | undefined {
  for (const pattern of SIGMA_PATTERNS) {
    const match = pattern.exec(text);
    if (!match) continue;
    const sigma = Number.parseFloat(match[1] ?? '');
    if (Number.isFinite(sigma) && sigma > 0 && sigma < 100) return sigma;
  }
  return undefined;
}

export function determineEvidenceLevel(text: string, sigmaLevel?: number): EvidenceLevel {
  const config = getConfig().criticalResearch ?? DEFAULT_CRITICAL_RESEARCH_CONFIG;
  const lowered = text.toLowerCase();
  if (sigmaLevel !== undefined && sigmaLevel >= config.discoveryMinSigma) return 'discovery';
  if (sigmaLevel !== undefined && sigmaLevel >= config.evidenceMinSigma) return 'evidence';
  if (HINT_KEYWORDS.some(keyword => lowered.includes(keyword))) return 'hint';
  if (THEORETICAL_KEYWORDS.some(keyword => lowered.includes(keyword))) return 'theoretical';
  if (CLAIM_KEYWORDS.some(keyword => lowered.includes(keyword))) return 'evidence';
  return 'indirect';
}

export function heuristicExtractClaimCandidates(text: string, maxClaims: number): Array<{ text: string; before: string; after: string }> {
  const cleaned = cleanMathML(text);
  const sentences = cleaned.split(/[.!?]+/).map(sentence => sentence.trim()).filter(sentence => sentence.length > 20);
  const claims: Array<{ text: string; before: string; after: string }> = [];
  for (let index = 0; index < sentences.length; index += 1) {
    const sentence = sentences[index] ?? '';
    const lowered = sentence.toLowerCase();
    if (!CLAIM_KEYWORDS.some(keyword => lowered.includes(keyword))) continue;
    claims.push({ text: sentence, before: sentences[index - 1] ?? '', after: sentences[index + 1] ?? '' });
    if (claims.length >= maxClaims) break;
  }
  return claims;
}

export function mapConfidenceLevel(score: number, stance: 'supported' | 'weak_support' | 'not_supported' | 'mixed' | 'conflicting'): ConfidenceLevel {
  if (stance === 'mixed' || stance === 'conflicting') return 'controversial';
  if (score >= 0.8) return 'high';
  if (score >= 0.55) return 'medium';
  return 'low';
}
