import type { CriticalAnalysisResult } from '../criticalAnalysis.js';
import type { DeepPaperAnalysis } from '../deepAnalyze.js';
import { CHALLENGE_RULES, EXPLICIT_NO_CHALLENGE, HUMANIZED_CHALLENGES, NON_METHODOLOGY_CUES, type ChallengeType, UNCERTAIN_CUES } from './challengeLexicon.js';

export type { ChallengeType } from './challengeLexicon.js';

export interface ExtractedChallenge { type: ChallengeType; confidence: number; evidence: string[]; }
export interface ChallengeExtractionResult { status: 'detected' | 'no_challenge_detected' | 'uncertain'; challenge_types: ChallengeType[]; challenges: ExtractedChallenge[]; }

function normalize(text: string): string {
  return ` ${text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim()} `;
}

function collectTexts(papers: DeepPaperAnalysis[], criticalResults?: CriticalAnalysisResult[]): string[] {
  const paperTexts = papers.flatMap(paper => [paper.methodology, paper.results, paper.discussion, paper.conclusions].filter((value): value is string => !!value));
  const criticalTexts = (criticalResults ?? []).flatMap(result => [
    ...(result.integrated_assessment?.key_concerns ?? []),
    ...(result.integrated_assessment?.recommendations ?? []),
    ...(result.questions?.red_flags ?? []).map(flag => flag.description),
  ]);
  return [...paperTexts, ...criticalTexts].map(normalize);
}

function scoreEvidence(texts: string[], terms: string[]): string[] {
  const hits = new Set<string>();
  for (const text of texts) {
    for (const term of terms) if (text.includes(normalize(term))) hits.add(term);
  }
  return [...hits];
}

export function extractMethodologyChallenges(papers: DeepPaperAnalysis[], criticalResults?: CriticalAnalysisResult[]): ChallengeExtractionResult {
  const texts = collectTexts(papers.slice(0, 5), criticalResults);
  const challenges: ExtractedChallenge[] = [];
  const hasExplicitNoChallenge = texts.some(text => EXPLICIT_NO_CHALLENGE.some(term => text.includes(normalize(term))));
  const hasOnlyNonMethodologyCue = texts.some(text => NON_METHODOLOGY_CUES.some(term => text.includes(normalize(term))))
    && !texts.some(text => CHALLENGE_RULES.some(rule => scoreEvidence([text], [...rule.strong, ...(rule.weak ?? [])]).length > 0));

  for (const rule of CHALLENGE_RULES) {
    const strongHits = scoreEvidence(texts, rule.strong);
    const weakHits = scoreEvidence(texts, rule.weak ?? []);
    const evidence = [...strongHits, ...weakHits].slice(0, 3);
    if (strongHits.length > 0 || (weakHits.length >= 2 && rule.type !== 'cross_cutting_methodology')) {
      challenges.push({ type: rule.type, confidence: Math.min(0.6 + strongHits.length * 0.2 + weakHits.length * 0.05, 0.95), evidence });
    }
  }

  if (challenges.length >= 2) {
    challenges.push({ type: 'cross_cutting_methodology', confidence: 0.7, evidence: challenges.flatMap(challenge => challenge.evidence).slice(0, 3) });
  }

  const deduped = [...new Map(challenges.map(challenge => [challenge.type, challenge])).values()];
  if (deduped.length > 0) {
    return { status: 'detected', challenge_types: deduped.map(challenge => challenge.type), challenges: deduped };
  }
  if (hasExplicitNoChallenge || hasOnlyNonMethodologyCue) {
    return { status: 'no_challenge_detected', challenge_types: [], challenges: [] };
  }
  if (texts.some(text => UNCERTAIN_CUES.some(term => text.includes(normalize(term))))) {
    return { status: 'uncertain', challenge_types: [], challenges: [] };
  }
  return { status: 'no_challenge_detected', challenge_types: [], challenges: [] };
}

export function renderMethodologyChallenges(result: ChallengeExtractionResult): string | undefined {
  if (result.status === 'no_challenge_detected') return undefined;
  if (result.status === 'uncertain') {
    return 'Possible methodological concerns are mentioned, but the available descriptions remain too underspecified to isolate a dominant challenge taxonomy.';
  }
  const labels = result.challenge_types.filter(type => type !== 'cross_cutting_methodology').slice(0, 3).map(type => HUMANIZED_CHALLENGES[type]);
  if (labels.length === 0) return undefined;
  const prefix = result.challenge_types.includes('cross_cutting_methodology') ? 'Across the collection, cross-cutting methodological tension appears around ' : 'Methodological challenges in this field include ';
  return `${prefix}${labels.join(', ')}. These issues require careful attention when interpreting results and comparing across different analyses.`;
}
