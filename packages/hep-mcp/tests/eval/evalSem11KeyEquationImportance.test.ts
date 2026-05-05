import { describe, expect, it } from 'vitest';

import { parseLatex } from '../../src/tools/research/latex/index.js';
import { identifyKeyEquations } from '../../src/tools/research/latex/keyEquationIdentifier.js';
import { readEvalSetFixture } from './evalSnapshots.js';

type Sem11Input = {
  latex: string;
  sampling_response: Record<string, unknown> | null;
};

async function runSem11Case(input: Sem11Input) {
  const ast = parseLatex(input.latex);
  const result = await identifyKeyEquations(ast, input.latex, {
    max_equations: 6,
    createMessage: input.sampling_response
      ? async () => ({
        model: 'mock-sem11',
        role: 'assistant',
        content: [{ type: 'text', text: JSON.stringify(input.sampling_response) }],
      } as any)
      : undefined,
  });

  return {
    selected_labels: result.filter(eq => eq.selection_status === 'selected').map(eq => eq.label ?? eq.candidate_key),
    status_by_label: Object.fromEntries(result.map(eq => [eq.label ?? eq.candidate_key, eq.selection_status])),
    importance_by_label: Object.fromEntries(
      result
        .filter(eq => eq.importance_band)
        .map(eq => [eq.label ?? eq.candidate_key, eq.importance_band])
    ),
    provenance_status: result[0]?.provenance.status ?? 'unavailable',
  };
}

describe('eval: sem11 key equation importance', () => {
  it('passes the eval hard cases', async () => {
    const evalSet = readEvalSetFixture('sem11/sem11_key_equation_importance_eval.json');
    for (const testCase of evalSet.cases) {
      const actual = await runSem11Case(testCase.input as Sem11Input);
      expect(actual).toEqual(testCase.expected);
    }
  });

  it('passes the holdout hard cases', async () => {
    const evalSet = readEvalSetFixture('sem11/sem11_key_equation_importance_holdout.json');
    for (const testCase of evalSet.cases) {
      const actual = await runSem11Case(testCase.input as Sem11Input);
      expect(actual).toEqual(testCase.expected);
    }
  });

  it('fails closed when heuristic candidate generation truncates equations before sampling', async () => {
    const latex = [
      '\\documentclass{article}\\begin{document}',
      '\\section{Setup}',
      'Eq.~\\eqref{eq:d1}, Eq.~\\eqref{eq:d2}, Eq.~\\eqref{eq:d3}, Eq.~\\eqref{eq:d4}, Eq.~\\eqref{eq:d5}, and Eq.~\\eqref{eq:d6} are setup identities.',
      'They are important for notation but not the final claim.',
      '\\begin{equation}\\label{eq:d1} a_1 = b_1 \\end{equation}',
      '\\begin{equation}\\label{eq:d2} a_2 = b_2 \\end{equation}',
      '\\begin{equation}\\label{eq:d3} a_3 = b_3 \\end{equation}',
      '\\begin{equation}\\label{eq:d4} a_4 = b_4 \\end{equation}',
      '\\begin{equation}\\label{eq:d5} a_5 = b_5 \\end{equation}',
      '\\begin{equation}\\label{eq:d6} a_6 = b_6 \\end{equation}',
      '\\section{Results}',
      'The actual nonperturbative statement is recorded below.',
      '\\begin{equation}\\label{eq:truth} \\Delta = \\exp(-S_0) \\end{equation}',
      "This relation is the paper's final result.",
      '\\end{document}',
    ].join('');
    const ast = parseLatex(latex);

    const result = await identifyKeyEquations(ast, latex, {
      max_equations: 6,
      createMessage: async () => ({
        model: 'mock-sem11',
        role: 'assistant',
        content: [{
          type: 'text',
          text: JSON.stringify({
            overall_status: 'selected',
            evaluations: [
              {
                candidate_key: 'eq:truth',
                selection_status: 'selected',
                importance_band: 'high',
                confidence: 0.97,
                reason_code: 'central_claim_equation',
                reason: 'This is the final scientific claim.',
              },
            ],
          }),
        }],
      } as any),
    });

    expect(result.map(eq => eq.label)).not.toContain('eq:truth');
    expect(result).toHaveLength(6);
    expect(result.every(eq => eq.selection_status !== 'selected')).toBe(true);
    expect(result[0]).toMatchObject({
      selection_status: 'unavailable',
      provenance: {
        status: 'unavailable',
        reason_code: 'candidate_generation_truncated',
      },
    });
  });

  it('assigns sections from equation source offsets rather than equation ordinals', async () => {
    const latex = [
      '\\documentclass{article}\\begin{document}',
      '\\section{Setup}',
      'Preliminary notation and narrative text.',
      '\\begin{equation}\\label{eq:setup} a=b \\end{equation}',
      '\\section{Results}',
      'A separate narrative introduces the main equation.',
      '\\begin{equation}\\label{eq:result} c=d \\end{equation}',
      '\\end{document}',
    ].join('');
    const ast = parseLatex(latex);

    const result = await identifyKeyEquations(ast, latex, {
      max_equations: 6,
    });

    expect(result.find(eq => eq.label === 'eq:setup')?.section).toBe('Setup');
    expect(result.find(eq => eq.label === 'eq:result')?.section).toBe('Results');
  });
});
