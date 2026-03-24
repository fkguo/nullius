import { DEFAULT_HALF_LIFE_DAYS, edgeExpectedSuccess } from './decay.js';
import { normalizeSignals } from './hash.js';
import { jaccardSimilarity } from './similarity.js';
import type { MemoryGraphStore } from './store.js';
import type { MemoryAdvice } from './types.js';

export const JACCARD_THRESHOLD = 0.34;
export const GENE_PRIOR_WEIGHT = 0.12;
export const MIN_ATTEMPTS_FOR_BAN = 2;
export const BAN_THRESHOLD = 0.25;
export const ADVICE_CANDIDATE_LIMIT = 200;
export const ADVICE_RECENCY_WINDOW_DAYS = 90;

export async function getMemoryAdvice(
  currentSignals: string[],
  store: Pick<MemoryGraphStore, 'getCandidateEdgeStats' | 'getGenePriorsBatch'>,
  now: Date = new Date(),
  halfLifeDays: number = DEFAULT_HALF_LIFE_DAYS,
): Promise<MemoryAdvice> {
  const normalizedSignals = normalizeSignals(currentSignals);
  if (normalizedSignals.length === 0) {
    return { preferredGeneId: null, bannedGeneIds: [], scores: new Map() };
  }

  const currentSet = new Set(normalizedSignals);
  const stats = await store.getCandidateEdgeStats(normalizedSignals, ADVICE_RECENCY_WINDOW_DAYS, ADVICE_CANDIDATE_LIMIT);

  const scores = new Map<string, number>();
  const evidenceScores = new Map<string, number>();
  const totals = new Map<string, number>();
  for (const row of stats) {
    const similarity = jaccardSimilarity(currentSet, new Set(JSON.parse(row.normalized_signals) as string[]));
    if (similarity < JACCARD_THRESHOLD) continue;
    const { value } = edgeExpectedSuccess(row, now, halfLifeDays);
    const weightedScore = value * similarity;
    evidenceScores.set(row.gene_id, (evidenceScores.get(row.gene_id) ?? 0) + weightedScore);
    scores.set(row.gene_id, (scores.get(row.gene_id) ?? 0) + weightedScore);
    totals.set(row.gene_id, (totals.get(row.gene_id) ?? 0) + row.total);
  }

  const priors = await store.getGenePriorsBatch([...scores.keys()]);
  for (const [geneId, score] of scores) {
    scores.set(geneId, score + (priors.get(geneId) ?? 0) * GENE_PRIOR_WEIGHT);
  }

  let preferredGeneId: string | null = null;
  let bestScore = 0;
  const bannedGeneIds: string[] = [];

  for (const [geneId, score] of scores) {
    if ((totals.get(geneId) ?? 0) >= MIN_ATTEMPTS_FOR_BAN && (evidenceScores.get(geneId) ?? score) <= BAN_THRESHOLD) {
      bannedGeneIds.push(geneId);
      continue;
    }
    if (score > bestScore) {
      bestScore = score;
      preferredGeneId = geneId;
    }
  }

  return { preferredGeneId, bannedGeneIds, scores };
}
