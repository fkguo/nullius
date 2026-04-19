import { cleanMathML } from '../../tools/research/preprocess/utils.js';
import { DEFAULT_CRITICAL_RESEARCH_CONFIG, getConfig } from '../../tools/research/config.js';
import type { CitationStance, ConfidenceLevel, EvidenceLevel } from './claimTypes.js';

const CLAIM_KEYWORDS = ['discover', 'observe', 'measure', 'find', 'detect', 'evidence', 'show', 'confirm', 'report', 'identify', 'constrain', 'determine'];
const THEORETICAL_KEYWORDS = ['predict', 'theoretical', 'model', 'suggest', 'imply', 'consistent with', 'expect', 'calculate'];
const HINT_KEYWORDS = ['hint', 'possible', 'potential', 'tentative', 'preliminary', 'indication', 'excess', 'anomaly'];
const SIGMA_PATTERNS = [/(-?\d+\.?\d*)\s*[σ\\sigma]/i, /(-?\d+\.?\d*)\s*sigma/i, /significance\s+of\s+(-?\d+\.?\d*)/i];

export interface StanceResult {
  stance: CitationStance;
  confidence: 'high' | 'medium' | 'low';
  matched_pattern?: string;
  needs_llm_review?: boolean;
}

export function analyzeCitationStance(abstract: string, claimKeywords: string[]): StanceResult {
  void abstract;
  void claimKeywords;
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
