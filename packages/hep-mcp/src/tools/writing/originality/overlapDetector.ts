/**
 * Originality Checker - N-gram Overlap Detection
 */

import type { CheckOriginalityParams, CheckOriginalityResult } from './types.js';
import { normalizeTextPreserveUnits } from '../../../utils/textNormalization.js';

const THRESHOLDS = {
  CRITICAL: 0.50,  // >50% is hard fail
  WARNING: 0.20,   // >20% needs review
};

/** Normalize text for comparison */
function normalizeText(text: string): string {
  const stripped = text
    .replace(/\\[a-zA-Z]+\{[^}]*\}/g, '')
    .replace(/\$[^$]+\$/g, '')
    .replace(/\\cite\{[^}]*\}/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return normalizeTextPreserveUnits(stripped);
}

/** Generate n-grams from text */
function generateNgrams(text: string, n: number): Set<string> {
  const words = text.split(/\s+/);
  const ngrams = new Set<string>();
  for (let i = 0; i <= words.length - n; i++) {
    ngrams.add(words.slice(i, i + n).join(' '));
  }
  return ngrams;
}

/** Calculate Jaccard similarity */
function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  const intersection = new Set([...a].filter(x => b.has(x)));
  const union = new Set([...a, ...b]);
  return union.size > 0 ? intersection.size / union.size : 0;
}

/** Check originality */
export function checkOriginality(params: CheckOriginalityParams): CheckOriginalityResult {
  const { generated_text, source_evidences, threshold = 0.20 } = params;
  const genNorm = normalizeText(generated_text);
  const genNgrams = generateNgrams(genNorm, 5);

  let maxOverlap = 0;
  for (const evidence of source_evidences) {
    const srcText = evidence.quote || evidence.caption || '';
    const srcNorm = normalizeText(srcText);
    const srcNgrams = generateNgrams(srcNorm, 5);
    const overlap = jaccardSimilarity(genNgrams, srcNgrams);
    maxOverlap = Math.max(maxOverlap, overlap);
  }

  const level: 'critical' | 'warning' | 'acceptable' =
    maxOverlap > THRESHOLDS.CRITICAL ? 'critical' :
    maxOverlap > THRESHOLDS.WARNING ? 'warning' : 'acceptable';

  return {
    level,
    is_acceptable: level !== 'critical',
    needs_review: level === 'warning',
    max_overlap: maxOverlap,
    flagged_count: maxOverlap > threshold ? 1 : 0,
  };
}
