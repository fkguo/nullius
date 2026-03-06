import { normalizeTextPreserveUnits } from '../../utils/textNormalization.js';

export type EvidenceRerankCandidateV1 = {
  evidence_id: string;
  semantic_score: number;
  text: string;
  importance_score?: number;
};

export type EvidenceRerankHitV1 = {
  evidence_id: string;
  score: number;
  semantic_score: number;
  token_overlap_ratio: number;
  importance_score: number;
};

function tokenize(text: string): string[] {
  return normalizeTextPreserveUnits(text)
    .replace(/[^a-zA-Z0-9_:+-]+/g, ' ')
    .split(' ')
    .map(token => token.trim())
    .filter(Boolean);
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function tokenOverlapRatio(queryTokens: string[], textTokens: string[]): number {
  if (queryTokens.length === 0) return 0;
  const textSet = new Set(textTokens);
  let overlap = 0;
  for (const token of queryTokens) {
    if (textSet.has(token)) overlap += 1;
  }
  return clamp01(overlap / queryTokens.length);
}

export function rerankEvidenceCandidates(params: {
  query: string;
  candidates: EvidenceRerankCandidateV1[];
  weights?: { semantic: number; overlap: number; importance: number };
}): EvidenceRerankHitV1[] {
  const weights = params.weights ?? { semantic: 0.75, overlap: 0.2, importance: 0.05 };
  const total = weights.semantic + weights.overlap + weights.importance;
  const wSemantic = total > 0 ? weights.semantic / total : 0.75;
  const wOverlap = total > 0 ? weights.overlap / total : 0.2;
  const wImportance = total > 0 ? weights.importance / total : 0.05;

  const queryTokensRaw = tokenize(params.query);
  const queryTokens = Array.from(new Set(queryTokensRaw));
  const maxSemantic = Math.max(1e-9, ...params.candidates.map(c => c.semantic_score));

  const hits: EvidenceRerankHitV1[] = params.candidates.map(candidate => {
    const overlap = tokenOverlapRatio(queryTokens, tokenize(candidate.text));
    const importance = clamp01(candidate.importance_score ?? 0);
    const semanticNorm = clamp01(candidate.semantic_score / maxSemantic);
    const score = clamp01(wSemantic * semanticNorm + wOverlap * overlap + wImportance * importance);
    return {
      evidence_id: candidate.evidence_id,
      score,
      semantic_score: candidate.semantic_score,
      token_overlap_ratio: overlap,
      importance_score: importance,
    };
  });

  hits.sort((left, right) => right.score - left.score || right.semantic_score - left.semantic_score || left.evidence_id.localeCompare(right.evidence_id));
  return hits;
}

