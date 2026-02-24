import { describe, it, expect } from 'vitest';

import { parseLatex, stringifyLatexNodes } from '../../../src/tools/research/latex/index.js';

describe('LaTeX AST stringify (safe)', () => {
  it('does not emit [object Object] for math-mode \\text', () => {
    const src = String.raw`$f_{\text{abc}}$`;
    const ast = parseLatex(src);
    const out = stringifyLatexNodes(ast.content);

    expect(out).toContain(String.raw`$f_{\text{abc}}$`);
    expect(out).not.toContain('[object Object]');
  });

  it('throws in strict mode for unhandled node kinds', () => {
    const src = String.raw`\verb|a|`;
    const ast = parseLatex(src);
    expect(() => stringifyLatexNodes(ast.content, { strict: true })).toThrow(/Unhandled LaTeX AST node kind/);
  });
});
