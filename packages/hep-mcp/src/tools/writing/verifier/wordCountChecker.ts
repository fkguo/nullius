export interface WordCountResult {
  pass: boolean;
  actual_words: number;
  min_words: number;
  max_words: number;
  feedback: string[];
}

export const CJK_REGEX = /[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]/g;
export const CJK_CHAR_TO_WORD_RATIO = 1.0 / 1.5;

export function countMixedTextUnits(text: string): {
  total_units: number;
  english_words: number;
  cjk_chars: number;
  latex_elements: number;
} {
  const cleaned = String(text ?? '')
    .replace(/\\cite\{[^}]+\}/g, '{{CITE}}')
    .replace(/\\eqref\{[^}]+\}/g, '{{CITE}}')
    .replace(/\\ref\{[^}]+\}/g, '{{REF}}')
    .replace(/\\[a-zA-Z]+\*?(?:\[[^\]]*\])?(?:\{[^}]*\})?/g, '{{LATEX}}');

  const cjkMatches = cleaned.match(CJK_REGEX) || [];
  const cjk_chars = cjkMatches.length;

  const nonCjk = cleaned.replace(CJK_REGEX, ' ');
  const tokens = nonCjk.split(/\s+/).filter(w => w.length > 0);
  const english_words = tokens.filter(t => !t.startsWith('{{')).length;
  const latex_elements = tokens.filter(t => t.startsWith('{{')).length;

  const cjk_word_equivalent = Math.ceil(cjk_chars * CJK_CHAR_TO_WORD_RATIO);

  return {
    total_units: english_words + cjk_word_equivalent + latex_elements,
    english_words,
    cjk_chars,
    latex_elements,
  };
}

function formatMixedTextBreakdown(units: { english_words: number; cjk_chars: number; latex_elements: number }): string {
  const cjk_word_equivalent = Math.ceil(units.cjk_chars * CJK_CHAR_TO_WORD_RATIO);
  return `english_words=${units.english_words}, cjk_chars=${units.cjk_chars} (~${cjk_word_equivalent} words), latex_elements=${units.latex_elements}`;
}

export function verifyWordCount(
  content: string,
  budget: { min_words: number; max_words: number }
): WordCountResult {
  const units = countMixedTextUnits(content);
  const words = units.total_units;
  const min_words = Number.isFinite(budget?.min_words) ? Math.max(0, Math.trunc(budget.min_words)) : 0;
  const max_words = Number.isFinite(budget?.max_words) ? Math.max(min_words, Math.trunc(budget.max_words)) : min_words;
  const feedback: string[] = [];

  if (words < min_words) {
    feedback.push(
      `Section has ~${words} words (${formatMixedTextBreakdown(units)}), below minimum ${min_words}. ` +
        `Add more content while staying grounded in provided claims/assets.`
    );
  }
  if (max_words > 0 && words > max_words * 1.2) {
    feedback.push(
      `Section has ~${words} words (${formatMixedTextBreakdown(units)}), significantly above maximum ${max_words}. ` +
        `Condense and remove redundancy.`
    );
  }

  return {
    pass: words >= min_words && (max_words === 0 ? true : words <= max_words * 1.2),
    actual_words: words,
    min_words,
    max_words,
    feedback,
  };
}
