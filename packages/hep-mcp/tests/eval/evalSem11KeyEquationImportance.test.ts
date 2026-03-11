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
});
