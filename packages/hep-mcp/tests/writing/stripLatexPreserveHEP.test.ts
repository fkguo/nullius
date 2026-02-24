import { describe, it, expect } from 'vitest';

import { stripLatexPreserveHEP } from '../../src/tools/writing/rag/hepTokenizer.js';

describe('stripLatexPreserveHEP', () => {
  it('drops reference commands without leaking label keys', () => {
    const input = String.raw`See Fig.~\ref{fig:one} and \eqref{eq:{nested}}. \label{eq:test}`;
    const out = stripLatexPreserveHEP(input);
    expect(out).not.toContain('fig:one');
    expect(out).not.toContain('eq:test');
    expect(out).not.toContain('eq:{nested}');
  });

  it('rewrites \\eq{...} to Eq. (balanced braces)', () => {
    const input = String.raw`See \eq{\textbf{eq:{nested}}} for details.`;
    const out = stripLatexPreserveHEP(input);
    expect(out).toContain('Eq.');
    expect(out).not.toContain('nested');
  });

  it('drops editorial macros with their content', () => {
    const input = String.raw`We \fk{[FK: TODO revise \eq{eq:test}]} study X.`;
    const out = stripLatexPreserveHEP(input);
    expect(out).toBe('We study X.');
    expect(out).not.toContain('FK');
    expect(out).not.toContain('TODO');
    expect(out).not.toContain('eq:test');
  });

  it('converts \\frac{a}{b} to a/b', () => {
    const input = String.raw`The ratio is \frac{1}{\sqrt{2}}.`;
    const out = stripLatexPreserveHEP(input);
    expect(out).toContain('1/sqrt(2)');
  });
});

