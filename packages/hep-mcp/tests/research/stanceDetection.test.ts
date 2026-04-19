/**
 * Stance Detection Tests
 * Heuristic stance analysis is diagnostic-only and must not emit authority-like judgments.
 */

import { describe, it, expect } from 'vitest';
import {
  analyzeCitationStance,
} from '../../src/tools/research/evidenceGrading.js';

describe('Stance Detection', () => {
  describe('analyzeCitationStance', () => {
    const claimKeywords = ['higgs', 'mass', 'measurement'];

    it('returns neutral low-confidence diagnostics even when lexical stance markers are present', () => {
      const abstract = 'Our measurement of the Higgs mass is consistent with previous results and in tension with one outlier.';
      const result = analyzeCitationStance(abstract, claimKeywords);

      expect(result.stance).toBe('neutral');
      expect(result.confidence).toBe('low');
      expect(result.needs_llm_review).toBe(true);
      expect(result.matched_pattern).toBeUndefined();
    });

    it('returns neutral low-confidence diagnostics for ordinary abstracts', () => {
      const abstract = 'We measure the Higgs boson mass using proton-proton collisions.';
      const result = analyzeCitationStance(abstract, claimKeywords);

      expect(result.stance).toBe('neutral');
      expect(result.confidence).toBe('low');
      expect(result.needs_llm_review).toBe(true);
    });

    it('returns neutral low-confidence diagnostics for empty abstracts', () => {
      const result = analyzeCitationStance('', claimKeywords);

      expect(result.stance).toBe('neutral');
      expect(result.confidence).toBe('low');
      expect(result.needs_llm_review).toBe(true);
    });
  });
});
