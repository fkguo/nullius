import { describe, expect, it, vi } from 'vitest';
import { compareWithBaseline, loadBaseline, runEvalSet, saveBaseline } from '../../src/eval/index.js';
import { gradeClaimAgainstEvidenceBundle } from '../../src/core/semantics/evidenceClaimGrading.js';
import { BASELINES_DIR, readEvalSetFixture } from './evalSnapshots.js';
import {
  aggregateMetrics,
  baselineGrade,
  buildClaim,
  type Sem02Actual,
  type Sem02Expected,
  type Sem02Input,
} from './sem02EvalSupport.js';

function buildAggregate(results: Parameters<typeof aggregateMetrics>[0]) {
  const overall = aggregateMetrics(results, () => true);
  const hard = aggregateMetrics(results, result => result.tags.includes('hard'));
  const negation = aggregateMetrics(results, result => result.tags.includes('negation'));
  const hedge = aggregateMetrics(results, result => result.tags.includes('hedge'));
  return {
    stance_accuracy_overall: overall.accuracy,
    macro_f1_overall: overall.macro_f1,
    fallback_rate_overall: overall.fallback_rate,
    abstention_rate_overall: overall.abstention_rate,
    stance_accuracy_hard: hard.accuracy,
    macro_f1_hard: hard.macro_f1,
    stance_accuracy_negation: negation.accuracy,
    stance_accuracy_hedge: hedge.accuracy,
  };
}

describe('eval: SEM-02 evidence claim grading (local-only)', () => {
  it('improves over heuristic baseline on hard semantic cases', async () => {
    const evalSet = readEvalSetFixture('sem02_evidence_claim_grading_eval.json');

    const baseline = await runEvalSet<Sem02Input, Sem02Actual>(evalSet, {
      run: async input => baselineGrade(input),
      judge: (expected, actual) => ({ passed: actual.stance === (expected as Sem02Expected).stance, metrics: { passed: actual.stance === (expected as Sem02Expected).stance ? 1 : 0 } }),
      aggregate: buildAggregate,
    });

    const improved = await runEvalSet<Sem02Input, Sem02Actual>(evalSet, {
      run: async (input, evalCase) => {
        const responses = [...input.mock_responses];
        const createMessage = vi.fn().mockImplementation(async () => {
          const response = responses.shift();
          return { model: 'mock-sem02', role: 'assistant', content: [{ type: 'text', text: response === 'INVALID' ? 'invalid json payload' : JSON.stringify(response) }] };
        });
        const grade = await gradeClaimAgainstEvidenceBundle(
          buildClaim(evalCase.id, input.claim_text),
          input.evidence_items.map(item => ({ ...item, source: 'confirmation_search' as const })),
          { createMessage },
          { prompt_version: 'sem02_eval_v1' },
        );
        return { stance: grade.aggregate_stance, usedFallback: grade.used_fallback, abstained: grade.aggregate_stance === 'not_supported' && grade.aggregate_confidence <= 0.3 };
      },
      judge: (expected, actual) => ({ passed: actual.stance === (expected as Sem02Expected).stance, metrics: { passed: actual.stance === (expected as Sem02Expected).stance ? 1 : 0 } }),
      aggregate: buildAggregate,
    });

    expect(improved.aggregateMetrics.stance_accuracy_overall ?? 0).toBeGreaterThanOrEqual(0.9);
    expect(improved.aggregateMetrics.macro_f1_overall ?? 0).toBeGreaterThanOrEqual(0.9);
    expect(improved.aggregateMetrics.stance_accuracy_hard ?? 0).toBeGreaterThanOrEqual(0.85);
    expect(improved.aggregateMetrics.stance_accuracy_negation ?? 0).toBeGreaterThanOrEqual(1);
    expect(improved.aggregateMetrics.stance_accuracy_hedge ?? 0).toBeGreaterThanOrEqual(1);
    expect(improved.aggregateMetrics.fallback_rate_overall ?? 1).toBeLessThanOrEqual(0.2);
    expect((improved.aggregateMetrics.stance_accuracy_overall ?? 0) - (baseline.aggregateMetrics.stance_accuracy_overall ?? 0)).toBeGreaterThanOrEqual(0.2);
    expect((improved.aggregateMetrics.macro_f1_overall ?? 0) - (baseline.aggregateMetrics.macro_f1_overall ?? 0)).toBeGreaterThanOrEqual(0.2);

    if (process.env.EVAL_UPDATE_BASELINES === '1') saveBaseline(improved, BASELINES_DIR);
    expect(compareWithBaseline(improved, loadBaseline(evalSet.name, BASELINES_DIR)).isFirstRun).toBe(false);
  });

  const holdoutIt = process.env.EVAL_INCLUDE_HOLDOUT === '1' ? it : it.skip;
  holdoutIt('locked holdout (run only at final gate)', async () => {
    const evalSet = readEvalSetFixture('sem02_evidence_claim_grading_holdout.json');
    const report = await runEvalSet<Sem02Input, Sem02Actual>(evalSet, {
      run: async (input, evalCase) => {
        const responses = [...input.mock_responses];
        const createMessage = vi.fn().mockImplementation(async () => {
          const response = responses.shift();
          return { model: 'mock-sem02', role: 'assistant', content: [{ type: 'text', text: response === 'INVALID' ? 'invalid json payload' : JSON.stringify(response) }] };
        });
        const grade = await gradeClaimAgainstEvidenceBundle(
          buildClaim(evalCase.id, input.claim_text),
          input.evidence_items.map(item => ({ ...item, source: 'confirmation_search' as const })),
          { createMessage },
          { prompt_version: 'sem02_holdout_v1' },
        );
        return { stance: grade.aggregate_stance, usedFallback: grade.used_fallback, abstained: grade.aggregate_stance === 'not_supported' && grade.aggregate_confidence <= 0.3 };
      },
      judge: (expected, actual) => ({ passed: actual.stance === (expected as Sem02Expected).stance, metrics: { passed: actual.stance === (expected as Sem02Expected).stance ? 1 : 0 } }),
      aggregate: results => aggregateMetrics(results, () => true),
    });

    expect(report.summary.total).toBe(4);
    expect(report.aggregateMetrics.accuracy ?? 0).toBeGreaterThanOrEqual(0.75);
    expect(report.aggregateMetrics.fallback_rate ?? 1).toBeLessThanOrEqual(0.3);
  });
});
