import { describe, it, expect, vi } from 'vitest';

import { compareWithBaseline, loadBaseline, runEvalSet, saveBaseline, type EvalResult } from '../../src/eval/index.js';
import { BASELINES_DIR, readEvalSetFixture } from './evalSnapshots.js';
import { adjudicateQuantityPair } from '../../src/core/semantics/quantityAdjudicator.js';
import type { QuantityDecisionV1 } from '../../src/core/semantics/quantityTypes.js';

type QuantityMentionInput = { quantity: string; context: string; unit?: string };
type Sem01Input = { a: QuantityMentionInput; b: QuantityMentionInput };
type Sem01Expected = { relation: QuantityDecisionV1; canonical_quantity: string };

type Sem01Actual = {
  relation: QuantityDecisionV1;
  canonical_quantity: string;
  confidence: number;
  reason_code: string;
  used_fallback: boolean;
};

function baselineRelation(input: Sem01Input): QuantityDecisionV1 {
  const kindOf = (mention: QuantityMentionInput): string | null => {
    // Baseline is intentionally lexical and context-blind: it only inspects the surface form.
    const text = `${mention.quantity}`.toLowerCase();
    if (text.includes('branching') || text.includes('\\mathcal{b}') || /\bbr\b/.test(text)) return 'branching';
    if (text.includes('cross section') || text.includes('\\sigma') || text.includes(' sigma')) return 'cross_section';
    if (text.includes('width') || text.includes('\\gamma') || text.includes('gamma')) return 'width';
    if (text.includes('lifetime') || text.includes('\\tau') || /\btau\b/.test(text)) return 'lifetime';
    if (text.includes('mass') || /\bm_/.test(text)) return 'mass';
    if (text.includes('asymmetry') || text.includes('a_cp')) return 'asymmetry';
    if (text.includes('alpha_s') || text.includes('coupling')) return 'coupling';
    return null;
  };

  const leftKind = kindOf(input.a);
  const rightKind = kindOf(input.b);
  if (!leftKind || !rightKind) return 'split';
  return leftKind === rightKind ? 'match' : 'split';
}

function computeRates(results: Array<EvalResult<Sem01Actual>>, filter: (r: EvalResult<Sem01Actual>) => boolean): {
  wrong_merge_rate: number;
  false_split_rate: number;
  pairwise_f1: number;
  abstention_rate: number;
} {
  const scoped = results.filter(filter);
  const evaluable = scoped.filter(r => r.actual !== null) as Array<EvalResult<Sem01Actual>>;

  let expectedMatch = 0;
  let expectedSplit = 0;

  let wrongMerge = 0;
  let falseSplit = 0;
  let abstained = 0;

  let tp = 0;
  let fp = 0;
  let fn = 0;

  for (const result of evaluable) {
    const expected = result.expected as Sem01Expected;
    const predicted = result.actual!.relation;

    if (expected.relation === 'match') {
      expectedMatch += 1;
      if (predicted === 'split') falseSplit += 1;
      if (predicted === 'uncertain') abstained += 1;
    }

    if (expected.relation === 'split') {
      expectedSplit += 1;
      if (predicted === 'match') wrongMerge += 1;
    }

    // Pairwise F1 on "match" vs "non-match", excluding expected=uncertain.
    if (expected.relation === 'uncertain') continue;
    const expectedPositive = expected.relation === 'match';
    const predictedPositive = predicted === 'match';
    if (expectedPositive && predictedPositive) tp += 1;
    else if (!expectedPositive && predictedPositive) fp += 1;
    else if (expectedPositive && !predictedPositive) fn += 1;
  }

  const precision = tp + fp > 0 ? tp / (tp + fp) : 0;
  const recall = tp + fn > 0 ? tp / (tp + fn) : 0;
  const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;

  return {
    wrong_merge_rate: expectedSplit > 0 ? wrongMerge / expectedSplit : 0,
    false_split_rate: expectedMatch > 0 ? falseSplit / expectedMatch : 0,
    pairwise_f1: f1,
    abstention_rate: expectedMatch > 0 ? abstained / expectedMatch : 0,
  };
}

describe('eval: SEM-01 quantity alignment (local-only)', () => {
  it('invokes MCP sampling when available (contract smoke test)', async () => {
    const createMessage = vi.fn().mockResolvedValue({
      model: 'mock-sem01',
      role: 'assistant',
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            decision: 'match',
            canonical_quantity: 'mass:x3872',
            confidence: 0.9,
            reason_code: 'same_quantity',
          }),
        },
      ],
    });

    const adjudication = await adjudicateQuantityPair(
      { quantity: 'm_{X(3872)}', context: 'We quote m_{X(3872)} = 3871.69 MeV.', unit: 'MeV' },
      { quantity: 'mass of X(3872)', context: 'The mass of X(3872) is 3871.69 MeV.', unit: 'MeV' },
      { createMessage },
    );

    expect(createMessage).toHaveBeenCalled();
    expect(createMessage.mock.calls[0]?.[0]).toMatchObject({
      metadata: {
        module: 'sem01_quantity_adjudicator',
        tool: 'hep_project_compare_measurements',
        prompt_version: 'v1',
        risk_level: 'read',
        cost_class: 'medium',
      },
    });
    expect(adjudication.provenance.backend).toBe('mcp_sampling');
    expect(adjudication.decision).toBe('match');
  });

  it('overrides MCP sampling match when units are incompatible', async () => {
    const createMessage = vi.fn().mockResolvedValue({
      model: 'mock-sem01',
      role: 'assistant',
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            decision: 'match',
            canonical_quantity: 'width:x3872',
            confidence: 0.9,
            reason_code: 'same_quantity',
          }),
        },
      ],
    });

    const adjudication = await adjudicateQuantityPair(
      { quantity: '\\\\Gamma_{X(3872)}', context: 'Width in MeV.', unit: 'MeV' },
      { quantity: '\\\\tau_{X(3872)}', context: 'Lifetime in ps.', unit: 'ps' },
      { createMessage },
    );

    expect(createMessage).not.toHaveBeenCalled();
    expect(adjudication.decision).toBe('split');
    expect(adjudication.reason_code).toBe('unit_incompatible');
  });

  it('improves wrong-merge/false-split vs lexical baseline', async () => {
    const evalSet = readEvalSetFixture('sem01_quantity_alignment_eval.json');

    const baseline = await runEvalSet<Sem01Input, Sem01Actual>(evalSet, {
      run: async input => {
        const relation = baselineRelation(input);
        return { relation, canonical_quantity: 'unknown', confidence: 0.5, reason_code: 'baseline', used_fallback: true };
      },
      judge: (expected, actual) => {
        const exp = expected as Sem01Expected;
        return { passed: exp.relation === actual.relation, metrics: { exact: exp.relation === actual.relation ? 1 : 0 } };
      },
      aggregate: results => {
        const overall = computeRates(results, () => true);
        const longTail = computeRates(results, r => r.tags.includes('long_tail'));
        const ood = computeRates(results, r => r.tags.includes('ood'));
        return {
          wrong_merge_rate_overall: overall.wrong_merge_rate,
          false_split_rate_overall: overall.false_split_rate,
          pairwise_f1_overall: overall.pairwise_f1,
          abstention_rate_overall: overall.abstention_rate,
          wrong_merge_rate_long_tail: longTail.wrong_merge_rate,
          false_split_rate_long_tail: longTail.false_split_rate,
          pairwise_f1_long_tail: longTail.pairwise_f1,
          abstention_rate_long_tail: longTail.abstention_rate,
          wrong_merge_rate_ood: ood.wrong_merge_rate,
          false_split_rate_ood: ood.false_split_rate,
          pairwise_f1_ood: ood.pairwise_f1,
          abstention_rate_ood: ood.abstention_rate,
        };
      },
    });

    const improved = await runEvalSet<Sem01Input, Sem01Actual>(evalSet, {
      run: async input => {
        const adjudication = await adjudicateQuantityPair(
          { quantity: input.a.quantity, context: input.a.context, unit: input.a.unit },
          { quantity: input.b.quantity, context: input.b.context, unit: input.b.unit },
        );
        return {
          relation: adjudication.decision,
          canonical_quantity: adjudication.canonical_quantity,
          confidence: adjudication.confidence,
          reason_code: adjudication.reason_code,
          used_fallback: adjudication.provenance.used_fallback,
        };
      },
      judge: (expected, actual) => {
        const exp = expected as Sem01Expected;
        return { passed: exp.relation === actual.relation, metrics: { exact: exp.relation === actual.relation ? 1 : 0 } };
      },
      aggregate: results => {
        const overall = computeRates(results, () => true);
        const longTail = computeRates(results, r => r.tags.includes('long_tail'));
        const ood = computeRates(results, r => r.tags.includes('ood'));
        return {
          wrong_merge_rate_overall: overall.wrong_merge_rate,
          false_split_rate_overall: overall.false_split_rate,
          pairwise_f1_overall: overall.pairwise_f1,
          abstention_rate_overall: overall.abstention_rate,
          wrong_merge_rate_long_tail: longTail.wrong_merge_rate,
          false_split_rate_long_tail: longTail.false_split_rate,
          pairwise_f1_long_tail: longTail.pairwise_f1,
          abstention_rate_long_tail: longTail.abstention_rate,
          wrong_merge_rate_ood: ood.wrong_merge_rate,
          false_split_rate_ood: ood.false_split_rate,
          pairwise_f1_ood: ood.pairwise_f1,
          abstention_rate_ood: ood.abstention_rate,
        };
      },
    });

    const baselineOverallWrongMerge = baseline.aggregateMetrics.wrong_merge_rate_overall ?? 1;
    const baselineOverallFalseSplit = baseline.aggregateMetrics.false_split_rate_overall ?? 1;
    const improvedOverallWrongMerge = improved.aggregateMetrics.wrong_merge_rate_overall ?? 1;
    const improvedOverallFalseSplit = improved.aggregateMetrics.false_split_rate_overall ?? 1;

    // Targets (SEM-01): absolute thresholds + relative improvement.
    expect(improvedOverallWrongMerge).toBeLessThanOrEqual(0.25);
    expect(improvedOverallFalseSplit).toBeLessThanOrEqual(0.25);

    const wrongMergeImprovement = baselineOverallWrongMerge - improvedOverallWrongMerge;
    const falseSplitImprovement = baselineOverallFalseSplit - improvedOverallFalseSplit;
    expect(wrongMergeImprovement).toBeGreaterThanOrEqual(Math.max(0.08, baselineOverallWrongMerge * 0.3));
    expect(falseSplitImprovement).toBeGreaterThanOrEqual(Math.max(0.08, baselineOverallFalseSplit * 0.3));

    // Regression baselines (for future): track current metrics for this eval set.
    if (process.env.EVAL_UPDATE_BASELINES === '1') {
      saveBaseline(improved, BASELINES_DIR);
    }
    const saved = loadBaseline(evalSet.name, BASELINES_DIR);
    const comparison = compareWithBaseline(improved, saved);
    expect(comparison.isFirstRun).toBe(false);
  });

  const holdoutIt = process.env.EVAL_INCLUDE_HOLDOUT === '1' ? it : it.skip;

  holdoutIt('holdout set (run only at final gate)', async () => {
    const evalSet = readEvalSetFixture('sem01_quantity_alignment_holdout.json');
    const report = await runEvalSet<Sem01Input, Sem01Actual>(evalSet, {
      run: async input => {
        const adjudication = await adjudicateQuantityPair(
          { quantity: input.a.quantity, context: input.a.context, unit: input.a.unit },
          { quantity: input.b.quantity, context: input.b.context, unit: input.b.unit },
        );
        return {
          relation: adjudication.decision,
          canonical_quantity: adjudication.canonical_quantity,
          confidence: adjudication.confidence,
          reason_code: adjudication.reason_code,
          used_fallback: adjudication.provenance.used_fallback,
        };
      },
      judge: (expected, actual) => {
        const exp = expected as Sem01Expected;
        return { passed: exp.relation === actual.relation, metrics: { exact: exp.relation === actual.relation ? 1 : 0 } };
      },
      aggregate: results => {
        const overall = computeRates(results, () => true);
        return {
          wrong_merge_rate_overall: overall.wrong_merge_rate,
          false_split_rate_overall: overall.false_split_rate,
          pairwise_f1_overall: overall.pairwise_f1,
          abstention_rate_overall: overall.abstention_rate,
        };
      },
    });

    // Holdout is for manual inspection; keep a minimal sanity floor.
    expect(report.summary.total).toBeGreaterThan(0);
    expect(report.aggregateMetrics.pairwise_f1_overall).toBeGreaterThan(0.5);
  });
});
