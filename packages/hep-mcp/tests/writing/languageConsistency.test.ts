import { describe, it, expect } from 'vitest';

import {
  detectLanguage,
  checkLanguageConsistency,
  calculateCjkRatio,
} from '../../src/tools/writing/verifier/languageChecker.js';

describe('Language Checker', () => {
  describe('detectLanguage', () => {
    it('detects English text', () => {
      expect(detectLanguage('This is an English sentence.')).toBe('en');
    });

    it('detects Chinese text', () => {
      expect(detectLanguage('这是一个中文句子。')).toBe('zh');
    });

    it('handles technical terms in Chinese text', () => {
      const text = '本文讨论 Higgs boson 的质量测量，使用 LHC 数据。';
      expect(detectLanguage(text)).toBe('zh');
    });

    it('detects mixed language text', () => {
      const text = 'This sentence包含中英文混合 content.';
      expect(detectLanguage(text)).toBe('mixed');
    });
  });

  describe('calculateCjkRatio', () => {
    it('returns 0 for empty text', () => {
      expect(calculateCjkRatio('')).toBe(0);
    });

    it('returns higher ratio for Chinese-heavy text', () => {
      expect(calculateCjkRatio('这是中文。This is English.')).toBeGreaterThan(0);
      expect(calculateCjkRatio('这是中文。This is English.')).toBeLessThan(1);
    });
  });

  describe('checkLanguageConsistency', () => {
    it('passes for consistent English sections', () => {
      const sections = [
        { number: '1', content: 'Introduction to the topic of particle physics.' },
        { number: '2', content: 'Experimental results show significant findings.' },
        { number: '3', content: 'In conclusion, the measurements are consistent.' },
      ];

      const result = checkLanguageConsistency(sections);
      expect(result.is_consistent).toBe(true);
      expect(result.dominant_language).toBe('en');
      expect(result.issues).toHaveLength(0);
    });

    it('fails for mixed-language sections', () => {
      const sections = [
        { number: '1', content: 'This is an English introduction.' },
        { number: '2', content: '这是一个中文章节，讨论实验结果。' },
      ];

      const result = checkLanguageConsistency(sections);
      expect(result.is_consistent).toBe(false);
      expect(result.issues.length).toBeGreaterThan(0);
      expect(result.suggestions.length).toBeGreaterThan(0);
    });
  });
});

