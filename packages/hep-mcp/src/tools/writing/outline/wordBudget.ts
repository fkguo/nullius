import type { OutlineSection, OutlineWordBudget, WordBudgetRange, SectionWordBudget } from './types.js';

export const WORD_BUDGET_BY_LENGTH: Record<'short' | 'medium' | 'long', WordBudgetRange> = {
  short: { min: 3000, max: 5000 },
  medium: { min: 5000, max: 20000 },
  long: { min: 20000, max: 50000 },
};

function getSectionWeight(section: OutlineSection): number {
  const claimCount = section.assigned_claims.length;
  const assetCount = section.assigned_figures.length + section.assigned_equations.length + section.assigned_tables.length;

  if (section.type === 'introduction') return Math.max(1, claimCount + assetCount * 0.5);
  if (section.type === 'summary') return Math.max(1, claimCount + assetCount * 0.3);
  return Math.max(1, claimCount + assetCount);
}

function allocateIntegerTotal(total: number, weights: number[]): number[] {
  if (weights.length === 0) return [];
  const safeTotal = Number.isFinite(total) ? Math.max(0, Math.trunc(total)) : 0;

  const sumWeights = weights.reduce((a, b) => a + b, 0);
  if (sumWeights <= 0 || safeTotal === 0) return weights.map(() => 0);

  const raw = weights.map(w => (safeTotal * w) / sumWeights);
  const floored = raw.map(x => Math.floor(x));
  let remainder = safeTotal - floored.reduce((a, b) => a + b, 0);

  const order = raw
    .map((x, i) => ({ frac: x - Math.floor(x), i }))
    .sort((a, b) => b.frac - a.frac);

  const out = [...floored];
  for (let k = 0; k < order.length && remainder > 0; k++) {
    out[order[k].i] += 1;
    remainder -= 1;
  }

  return out;
}

/**
 * Calculate per-section budgets (min/max words) from a total budget.
 *
 * Notes:
 * - Uses a simple weight model based on assigned claims/assets.
 * - Allocates budgets across the provided top-level outline only (subsections excluded).
 */
export function calculatePerSectionBudget(
  outline: OutlineSection[],
  totalBudget: WordBudgetRange
): OutlineWordBudget['per_section'] {
  const weights = outline.map(getSectionWeight);
  const mins = allocateIntegerTotal(totalBudget.min, weights);
  const maxs = allocateIntegerTotal(totalBudget.max, weights);

  const perSection: SectionWordBudget[] = outline.map((section, i) => {
    const min_words = Math.max(0, mins[i] ?? 0);
    const max_words = Math.max(min_words, maxs[i] ?? min_words);
    return { section_number: section.number, min_words, max_words };
  });

  return perSection;
}

