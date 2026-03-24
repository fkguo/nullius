import type { EdgeStat } from './types.js';

export const DEFAULT_HALF_LIFE_DAYS = 30;

export interface EdgeExpectedSuccess {
  p: number;
  w: number;
  total: number;
  value: number;
}

export function decayWeight(
  eventTs: Date | string,
  now: Date = new Date(),
  halfLifeDays: number = DEFAULT_HALF_LIFE_DAYS,
): number {
  const ts = typeof eventTs === 'string' ? new Date(eventTs) : eventTs;
  const ageDays = (now.getTime() - ts.getTime()) / (1000 * 60 * 60 * 24);
  if (!Number.isFinite(ageDays) || ageDays <= 0) return 1;
  return Math.pow(0.5, ageDays / halfLifeDays);
}

export function laplaceProbability(success: number, total: number): number {
  return (success + 1) / (total + 2);
}

export function edgeExpectedSuccess(
  stats: Pick<EdgeStat, 'success' | 'total' | 'last_ts'>,
  now: Date = new Date(),
  halfLifeDays: number = DEFAULT_HALF_LIFE_DAYS,
): EdgeExpectedSuccess {
  const p = laplaceProbability(stats.success, stats.total);
  const w = decayWeight(stats.last_ts, now, halfLifeDays);
  return { p, w, total: stats.total, value: p * w };
}
