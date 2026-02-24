import { describe, it, expect } from 'vitest';

import { verifyDeterministicSectionStructure } from '../../src/vnext/writing/sectionStructureVerifier.js';

describe('vNext: deterministic section structure gate', () => {
  it('flags mismatched LaTeX environments (stack-aware)', () => {
    const content = [
      '\\begin{equation}',
      'a=b',
      '\\begin{aligned}',
      'c=d',
      '\\end{equation}',
      '\\end{aligned}',
    ].join('\n');

    const res = verifyDeterministicSectionStructure({
      content,
      min_paragraphs: 1,
      max_single_sentence_paragraphs: 10,
      require_no_unclosed_environments: true,
    });

    expect(res.pass).toBe(false);
    expect(res.diagnostics.unclosed_environments).toContain('aligned');
    expect(res.diagnostics.unclosed_environments).not.toContain('equation');
  });
});

