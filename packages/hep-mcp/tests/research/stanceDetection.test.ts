/**
 * Stance Detection Tests
 * Tests for citation stance analysis in evidence grading
 */

import { describe, it, expect } from 'vitest';
import {
  analyzeCitationStance,
  type CitationStance,
  type StanceResult,
} from '../../src/tools/research/evidenceGrading.js';

describe('Stance Detection', () => {
  describe('analyzeCitationStance', () => {
    const claimKeywords = ['higgs', 'mass', 'measurement'];

    describe('confirming patterns', () => {
      it('should detect "consistent with" as confirming', () => {
        const abstract = 'Our measurement of the Higgs mass is consistent with previous results.';
        const result = analyzeCitationStance(abstract, claimKeywords);

        expect(result.stance).toBe('confirming');
        expect(result.matched_pattern).toBe('consistent with');
      });

      it('should detect "in agreement" as confirming', () => {
        const abstract = 'The Higgs mass value is in agreement with the Standard Model prediction.';
        const result = analyzeCitationStance(abstract, claimKeywords);

        expect(result.stance).toBe('confirming');
      });

      it('should detect "confirms" as confirming', () => {
        const abstract = 'This measurement confirms the earlier discovery of the Higgs boson.';
        const result = analyzeCitationStance(abstract, claimKeywords);

        expect(result.stance).toBe('confirming');
      });

      it('should detect "supports" as confirming', () => {
        const abstract = 'Our data supports the mass measurement reported by ATLAS.';
        const result = analyzeCitationStance(abstract, claimKeywords);

        expect(result.stance).toBe('confirming');
      });
    });

    describe('contradicting patterns', () => {
      it('should detect "in tension with" as contradicting', () => {
        const abstract = 'Our Higgs mass measurement is in tension with the previous result.';
        const result = analyzeCitationStance(abstract, claimKeywords);

        expect(result.stance).toBe('contradicting');
        expect(result.matched_pattern).toBe('in tension with');
      });

      it('should detect "contradicts" as contradicting', () => {
        const abstract = 'This result contradicts the earlier mass measurement.';
        const result = analyzeCitationStance(abstract, claimKeywords);

        expect(result.stance).toBe('contradicting');
      });

      it('should detect "rules out" as contradicting', () => {
        const abstract = 'Our analysis rules out the previously reported Higgs mass value.';
        const result = analyzeCitationStance(abstract, claimKeywords);

        expect(result.stance).toBe('contradicting');
      });

      it('should detect "inconsistent with" as contradicting', () => {
        const abstract = 'The measurement is inconsistent with theoretical predictions.';
        const result = analyzeCitationStance(abstract, claimKeywords);

        expect(result.stance).toBe('contradicting');
      });
    });

    describe('neutral cases', () => {
      it('should return neutral for abstract without stance patterns', () => {
        const abstract = 'We measure the Higgs boson mass using proton-proton collisions.';
        const result = analyzeCitationStance(abstract, claimKeywords);

        expect(result.stance).toBe('neutral');
        expect(result.needs_llm_review).toBe(true);
      });

      it('should return neutral for empty abstract', () => {
        const result = analyzeCitationStance('', claimKeywords);

        expect(result.stance).toBe('neutral');
        expect(result.confidence).toBe('low');
        expect(result.needs_llm_review).toBe(true);
      });
    });

    describe('confidence levels', () => {
      it('should have high confidence when keyword found in context', () => {
        const abstract = 'The Higgs mass measurement is consistent with previous results.';
        const result = analyzeCitationStance(abstract, claimKeywords);

        expect(result.confidence).toBe('high');
      });

      it('should have medium confidence when no keyword context', () => {
        const abstract = 'This result is consistent with theoretical predictions.';
        const result = analyzeCitationStance(abstract, ['nonexistent']);

        expect(result.confidence).toBe('medium');
      });

      it('should have low confidence for neutral stance', () => {
        const abstract = 'We present a new measurement technique.';
        const result = analyzeCitationStance(abstract, claimKeywords);

        expect(result.confidence).toBe('low');
      });
    });

    describe('priority handling', () => {
      it('should prioritize contradicting over confirming', () => {
        // Abstract with both patterns - contradicting should win
        const abstract = 'While consistent with some models, our result is in tension with the main prediction.';
        const result = analyzeCitationStance(abstract, ['result', 'prediction']);

        expect(result.stance).toBe('contradicting');
      });
    });
  });
});
