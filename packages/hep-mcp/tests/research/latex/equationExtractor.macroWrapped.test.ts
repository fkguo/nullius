import { describe, it, expect } from 'vitest';

import { extractEquations, parseLatex } from '../../../src/tools/research/latex/index.js';
import { MACRO_WRAPPED_EQUATIONS_LATEX_FIXTURE } from '../../fixtures/latex/macroWrappedFixture.js';

describe('Equation extractor (macro-wrapped environments)', () => {
  it('extracts macro-wrapped equations and produces sane locators', () => {
    const ast = parseLatex(MACRO_WRAPPED_EQUATIONS_LATEX_FIXTURE);
    const equations = extractEquations(ast, {
      file: 'main.tex',
      includeInline: false,
      content: MACRO_WRAPPED_EQUATIONS_LATEX_FIXTURE,
    });

    const labeled = equations.find((eq) => eq.label === 'eq:test');
    expect(labeled).toBeTruthy();
    expect(labeled?.envName).toBe('equation');

    const loc = labeled?.location;
    expect(loc).toBeTruthy();
    expect(loc?.offset).toBeGreaterThanOrEqual(0);
    expect(loc?.endOffset).toBeGreaterThan(loc?.offset ?? 0);

    expect(equations.some((eq) => eq.envName === 'eqnarray*')).toBe(true);
  });

  it('does not treat macro definitions as equations', () => {
    const content = String.raw`\documentclass{article}
\begin{document}
\newcommand{\foo}{\begin{equation}bad\end{equation}}
\be a=b \ee
\end{document}
`;

    const ast = parseLatex(content);
    const equations = extractEquations(ast, { content, includeInline: false, file: 'main.tex' });

    expect(equations).toHaveLength(1);
    expect(equations[0]?.latex).toContain('a=b');
    expect(equations[0]?.latex).not.toContain('bad');
  });
});
