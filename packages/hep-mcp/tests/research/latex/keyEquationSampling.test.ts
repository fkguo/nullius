import { describe, expect, it } from 'vitest';

import { buildKeyEquationAssessmentPrompt } from '../../../src/tools/research/latex/keyEquationSampling.js';

describe('buildKeyEquationAssessmentPrompt', () => {
  it('truncates oversized prompt fields with a marker', () => {
    const longLatex = 'x'.repeat(1400);
    const longContext = 'c'.repeat(1000);
    const longAbstract = 'a'.repeat(2600);
    const prompt = buildKeyEquationAssessmentPrompt({
      prompt_version: 'test',
      document_title: 'Title',
      abstract: longAbstract,
      candidates: [{
        candidate_key: 'eq:1',
        latex: longLatex,
        reference_count: 2,
        context_text: longContext,
        signal_summary: ['s1', 's2'],
      }],
    });

    expect(prompt).toContain('...[truncated]');
    expect(prompt).not.toContain(longLatex);
    expect(prompt).not.toContain(longContext);
    expect(prompt).not.toContain(longAbstract);
  });
});
