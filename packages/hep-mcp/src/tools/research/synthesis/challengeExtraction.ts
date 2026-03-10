import type { CriticalAnalysisResult } from '../criticalAnalysis.js';
import type { DeepPaperAnalysis } from '../deepAnalyze.js';
import {
  CHALLENGE_NORMALIZATION_HINTS,
  EXPLICIT_NO_CHALLENGE,
  HUMANIZED_CHALLENGES,
  NON_METHODOLOGY_CUES,
  OPEN_CHALLENGE_MARKERS,
  type ChallengeType,
  UNCERTAIN_CUES,
} from './challengeLexicon.js';

export type { ChallengeType } from './challengeLexicon.js';

export interface ChallengeExtractionProvenance { mode: 'open_text' | 'heuristic_fallback' | 'uncertain' | 'no_challenge'; used_fallback: boolean; reason_code: string; evidence_count: number; }
export interface ExtractedChallenge { type?: ChallengeType; summary: string; confidence: number; evidence: string[]; provenance: Pick<ChallengeExtractionProvenance, 'mode' | 'used_fallback' | 'reason_code'>; }
export interface ChallengeExtractionResult { status: 'detected' | 'no_challenge_detected' | 'uncertain'; challenge_types: ChallengeType[]; challenges: ExtractedChallenge[]; provenance: ChallengeExtractionProvenance; }

type TextRecord = { normalized: string; original: string };

function normalize(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').trim();
}

function collectTexts(papers: DeepPaperAnalysis[], criticalResults?: CriticalAnalysisResult[]): TextRecord[] {
  const paperTexts = papers.flatMap(paper => [paper.methodology, paper.results, paper.discussion, paper.conclusions].filter((value): value is string => !!value));
  const criticalTexts = (criticalResults ?? []).flatMap(result => [
    ...(result.integrated_assessment?.key_concerns ?? []),
    ...(result.integrated_assessment?.recommendations ?? []),
    ...(result.questions?.red_flags ?? []).map(flag => flag.description),
  ]);
  return [...paperTexts, ...criticalTexts].flatMap(text => text.split(/[\n.;!?]+/)).map(text => text.trim()).filter(Boolean).map(text => ({ normalized: normalize(text), original: text }));
}

function normalizeChallengeTypes(text: string): ChallengeType[] {
  const matches = CHALLENGE_NORMALIZATION_HINTS.map(hint => ({
    type: hint.type,
    score: [...hint.strong, ...(hint.weak ?? [])].reduce((sum, term) => sum + (text.includes(normalize(term)) ? term.split(' ').length : 0), 0),
  })).filter(match => match.score > 0).sort((left, right) => right.score - left.score);
  return matches.map(match => match.type);
}

function openChallenges(texts: TextRecord[]): ExtractedChallenge[] {
  const deduped = new Map<string, ExtractedChallenge>();
  for (const text of texts) {
    if (EXPLICIT_NO_CHALLENGE.some(term => text.normalized.includes(normalize(term)))) continue;
    if (!OPEN_CHALLENGE_MARKERS.some(marker => text.normalized.includes(normalize(marker)))) continue;
    const summary = text.original.replace(/\s+/g, ' ').trim();
    const types = normalizeChallengeTypes(text.normalized);
    if (types.length === 0 && (UNCERTAIN_CUES.some(term => text.normalized.includes(normalize(term))) || NON_METHODOLOGY_CUES.some(term => text.normalized.includes(normalize(term))))) {
      continue;
    }
    if (types.length === 0) {
      deduped.set(summary.toLowerCase(), {
        summary,
        confidence: 0.55,
        evidence: [summary],
        provenance: { mode: 'open_text', used_fallback: false, reason_code: 'challenge_marker_sentence' },
      });
      continue;
    }
    for (const type of types) {
      deduped.set(`${summary.toLowerCase()}:${type}`, {
        type,
        summary,
        confidence: 0.75,
        evidence: [summary],
        provenance: { mode: 'open_text', used_fallback: false, reason_code: 'challenge_marker_sentence' },
      });
    }
  }
  return [...deduped.values()].slice(0, 5);
}

function fallbackChallenges(texts: TextRecord[]): ExtractedChallenge[] {
  const challenges = CHALLENGE_NORMALIZATION_HINTS.flatMap(hint => {
    const evidence = texts.filter(text => [...hint.strong, ...(hint.weak ?? [])].some(term => text.normalized.includes(normalize(term)))).map(text => text.original).slice(0, 2);
    if (evidence.length === 0) return [];
    return [{
      type: hint.type,
      summary: HUMANIZED_CHALLENGES[hint.type],
      confidence: Math.min(0.5 + evidence.length * 0.15, 0.8),
      evidence,
      provenance: { mode: 'heuristic_fallback' as const, used_fallback: true, reason_code: 'normalization_hint_match' as const },
    }];
  });
  return challenges.slice(0, 4);
}

function finalizeDetected(challenges: ExtractedChallenge[], mode: ChallengeExtractionProvenance['mode']): ChallengeExtractionResult {
  const types = [...new Set(challenges.map(challenge => challenge.type).filter((type): type is ChallengeType => !!type))];
  if (types.length >= 2) types.push('cross_cutting_methodology');
  return {
    status: 'detected',
    challenge_types: [...new Set(types)],
    challenges,
    provenance: {
      mode,
      used_fallback: mode === 'heuristic_fallback',
      reason_code: mode === 'open_text' ? 'open_text_challenge_sentences' : 'fallback_normalization_hints',
      evidence_count: challenges.length,
    },
  };
}

export function extractMethodologyChallenges(papers: DeepPaperAnalysis[], criticalResults?: CriticalAnalysisResult[]): ChallengeExtractionResult {
  const texts = collectTexts(papers.slice(0, 5), criticalResults);
  const open = openChallenges(texts);
  if (open.length > 0) return finalizeDetected(open, 'open_text');
  const fallback = fallbackChallenges(texts);
  if (fallback.length > 0) return finalizeDetected(fallback, 'heuristic_fallback');
  if (texts.some(text => EXPLICIT_NO_CHALLENGE.some(term => text.normalized.includes(normalize(term))) || NON_METHODOLOGY_CUES.some(term => text.normalized.includes(normalize(term))))) {
    return { status: 'no_challenge_detected', challenge_types: [], challenges: [], provenance: { mode: 'no_challenge', used_fallback: false, reason_code: 'explicit_no_challenge_signal', evidence_count: 0 } };
  }
  if (texts.some(text => UNCERTAIN_CUES.some(term => text.normalized.includes(normalize(term))))) {
    return { status: 'uncertain', challenge_types: [], challenges: [], provenance: { mode: 'uncertain', used_fallback: false, reason_code: 'underspecified_challenge_signal', evidence_count: 0 } };
  }
  return { status: 'no_challenge_detected', challenge_types: [], challenges: [], provenance: { mode: 'no_challenge', used_fallback: false, reason_code: 'no_challenge_signal', evidence_count: 0 } };
}

function describeChallenge(challenge: ExtractedChallenge): string {
  return challenge.type ? HUMANIZED_CHALLENGES[challenge.type] : challenge.summary.toLowerCase();
}

export function renderMethodologyChallenges(result: ChallengeExtractionResult): string | undefined {
  if (result.status === 'no_challenge_detected') return undefined;
  if (result.status === 'uncertain') {
    return 'Possible methodological concerns are mentioned, but the available descriptions remain too underspecified to isolate a dominant challenge pattern.';
  }
  const descriptions = [...new Set(result.challenges.map(describeChallenge))].slice(0, 3);
  if (descriptions.length === 0) return undefined;
  if (result.provenance.mode === 'heuristic_fallback') {
    return `Heuristic fallback signals suggest methodological concerns around ${descriptions.join(', ')}; manual validation is advisable before treating these categories as authoritative.`;
  }
  return `Across the collection, the available descriptions repeatedly flag methodological concerns around ${descriptions.join(', ')}.`;
}
