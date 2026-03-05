export type MetricFn<T> = (results: T[]) => number;

function safeDivide(numerator: number, denominator: number): number {
  return denominator > 0 ? numerator / denominator : 0;
}

export function precision(tp: number, fp: number): number {
  return safeDivide(tp, tp + fp);
}

export function recall(tp: number, fn: number): number {
  return safeDivide(tp, tp + fn);
}

export function f1(p: number, r: number): number {
  return safeDivide(2 * p * r, p + r);
}

export function accuracy(correct: number, total: number): number {
  return safeDivide(correct, total);
}

export function recallAtK(ranks: Array<number | null>, k: number): number {
  if (k <= 0) return 0;
  const hitCount = ranks.filter(rank => rank !== null && rank <= k).length;
  return safeDivide(hitCount, ranks.length);
}

export function mrrAtK(ranks: Array<number | null>, k: number): number {
  if (k <= 0 || ranks.length === 0) return 0;
  let reciprocalSum = 0;
  for (const rank of ranks) {
    if (rank === null || rank > k) continue;
    reciprocalSum += 1 / rank;
  }
  return reciprocalSum / ranks.length;
}

export function precisionAtK(ranks: Array<number | null>, k: number): number {
  if (k <= 0) return 0;
  const hitCount = ranks.filter(rank => rank !== null && rank <= k).length;
  return safeDivide(hitCount, ranks.length * k);
}

export function abstentionRate(results: Array<{ abstained: boolean }>): number {
  if (results.length === 0) return 0;
  const abstainedCount = results.filter(result => result.abstained).length;
  return abstainedCount / results.length;
}

export function fallbackRate(results: Array<{ usedFallback: boolean }>): number {
  if (results.length === 0) return 0;
  const fallbackCount = results.filter(result => result.usedFallback).length;
  return fallbackCount / results.length;
}
