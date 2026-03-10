import { MethodologyChallengeExtractionResultSchema } from '@autoresearch/shared';
import { describe, expect, it } from 'vitest';
import { loadBaseline, runEvalSet } from '../../src/eval/index.js';
import { extractMethodologyChallenges, type ChallengeExtractionResult } from '../../src/tools/research/synthesis/challengeExtraction.js';
import { BASELINES_DIR, readEvalSetFixture } from './evalSnapshots.js';
import { aggregateSem13, type Sem13Actual, type Sem13Expected, type Sem13Input } from './sem13EvalSupport.js';

describe('eval: SEM-13 challenge extractor', () => {
  it('beats the locked includes-based baseline on structured challenge cases', async () => {
    const evalSet = readEvalSetFixture('sem13/sem13_challenge_extractor_eval.json');
    const lockedBaseline = loadBaseline(evalSet.name, BASELINES_DIR);
    if (!lockedBaseline) throw new Error(`Missing locked baseline for ${evalSet.name}`);

    const improved = await runEvalSet<Sem13Input, Sem13Actual>(evalSet, {
      run: async input => MethodologyChallengeExtractionResultSchema.parse(
        extractMethodologyChallenges(
          input.papers as never[],
          input.critical_results as never[] | undefined,
        ),
      ),
      judge: (expected, actual) => {
        const exp = expected as Sem13Expected;
        const pass = exp.status === actual.status && JSON.stringify([...exp.challenge_types].sort()) === JSON.stringify([...actual.challenge_types].sort());
        return { passed: pass, metrics: { passed: pass ? 1 : 0 } };
      },
      aggregate: aggregateSem13,
    });

    expect(improved.aggregateMetrics.challenge_recall_overall ?? 0).toBeGreaterThanOrEqual((lockedBaseline.metrics.challenge_recall_overall ?? 0) + 0.1);
    expect(improved.aggregateMetrics.no_challenge_uncertain_accuracy ?? 0).toBeGreaterThanOrEqual(0.85);
    expect(improved.aggregateMetrics.false_positive_rate ?? 1).toBeLessThanOrEqual(lockedBaseline.metrics.false_positive_rate ?? 1);
  });

  const holdoutIt = process.env.EVAL_INCLUDE_HOLDOUT === '1' ? it : it.skip;
  holdoutIt('holds structured challenge extraction on the locked holdout', async () => {
    const evalSet = readEvalSetFixture('sem13/sem13_challenge_extractor_holdout.json');
    const report = await runEvalSet<Sem13Input, ChallengeExtractionResult>(evalSet, {
      run: async input => MethodologyChallengeExtractionResultSchema.parse(
        extractMethodologyChallenges(
          input.papers as never[],
          input.critical_results as never[] | undefined,
        ),
      ),
      judge: (expected, actual) => {
        const exp = expected as Sem13Expected;
        const pass = exp.status === actual.status;
        return { passed: pass, metrics: { passed: pass ? 1 : 0 } };
      },
      aggregate: aggregateSem13,
    });

    expect(report.aggregateMetrics.challenge_recall_overall ?? 0).toBeGreaterThanOrEqual(0.75);
    expect(report.aggregateMetrics.no_challenge_uncertain_accuracy ?? 0).toBeGreaterThanOrEqual(0.8);
  });
});
