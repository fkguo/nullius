import { describe, it, expect } from 'vitest';

import {
  CJK_CHAR_TO_WORD_RATIO,
  countMixedTextUnits,
  verifyWordCount,
} from '../../src/tools/writing/verifier/wordCountChecker.js';

describe('Word count (mixed English/CJK + LaTeX)', () => {
  it('counts pure English words', () => {
    const units = countMixedTextUnits('Hello world');
    expect(units.english_words).toBe(2);
    expect(units.cjk_chars).toBe(0);
    expect(units.latex_elements).toBe(0);
    expect(units.total_units).toBe(2);
  });

  it('counts pure Chinese characters with ratio', () => {
    const units = countMixedTextUnits('你好世界');
    expect(units.english_words).toBe(0);
    expect(units.cjk_chars).toBe(4);
    expect(units.latex_elements).toBe(0);
    expect(units.total_units).toBe(3); // ceil(4 / 1.5) = 3
  });

  it('counts mixed English + Chinese', () => {
    const units = countMixedTextUnits('Hello 世界 test');
    expect(units.english_words).toBe(2);
    expect(units.cjk_chars).toBe(2);
    expect(units.latex_elements).toBe(0);
    expect(units.total_units).toBe(4); // 2 + ceil(2 / 1.5) = 4
  });

  it('counts LaTeX elements separately', () => {
    const units = countMixedTextUnits('\\cite{foo} 测试');
    expect(units.english_words).toBe(0);
    expect(units.cjk_chars).toBe(2);
    expect(units.latex_elements).toBe(1);
    expect(units.total_units).toBe(3);
  });

  it('does not count Chinese punctuation as CJK chars', () => {
    const units = countMixedTextUnits('你好，世界。');
    expect(units.cjk_chars).toBe(4);
  });

  it('exports CJK_CHAR_TO_WORD_RATIO constant', () => {
    expect(CJK_CHAR_TO_WORD_RATIO).toBeCloseTo(1 / 1.5, 12);
  });

  it('includes mixed breakdown in feedback when failing', () => {
    const res = verifyWordCount('你好世界', { min_words: 10, max_words: 10 });
    expect(res.pass).toBe(false);
    expect(res.feedback[0]).toContain('english_words=');
    expect(res.feedback[0]).toContain('cjk_chars=');
    expect(res.feedback[0]).toContain('latex_elements=');
  });
});

