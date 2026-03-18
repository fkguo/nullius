import { MethodologyChallengeExtractionResultSchema } from '@autoresearch/shared';
import { describe, expect, it } from 'vitest';
import { loadBaseline, runEvalSet } from '../../src/eval/index.js';
import {
  extractMethodologyChallenges,
  renderMethodologyChallenges,
  type ChallengeExtractionResult,
} from '../../src/tools/research/synthesis/challengeExtraction.js';
import { BASELINES_DIR, readEvalSetFixture } from './evalSnapshots.js';
import {
  aggregateSem13,
  evaluateSem13,
  type Sem13Actual,
  type Sem13Expected,
  type Sem13Input,
} from './sem13EvalSupport.js';

describe('eval: SEM-13 challenge extractor', () => {
  it('locks challenge extraction to evidence-backed summaries rather than taxonomy wording', async () => {
    const evalSet = readEvalSetFixture('sem13/sem13_challenge_extractor_eval.json');
    const lockedBaseline = loadBaseline(evalSet.name, BASELINES_DIR);
    if (!lockedBaseline) {
      throw new Error(`Missing locked baseline for ${evalSet.name}`);
    }

    const improved = await runEvalSet<Sem13Input, Sem13Actual>(evalSet, {
      run: async input => {
        const result = MethodologyChallengeExtractionResultSchema.parse(
          extractMethodologyChallenges(
            input.papers as never[],
            input.critical_results as never[] | undefined,
          ),
        );
        return {
          ...result,
          rendered_summary: renderMethodologyChallenges(result),
        };
      },
      judge: (expected, actual) => {
        const evaluation = evaluateSem13(expected as Sem13Expected, actual);
        return {
          passed: evaluation.passed,
          metrics: { passed: evaluation.passed ? 1 : 0 },
        };
      },
      aggregate: aggregateSem13,
    });

    expect(
      improved.aggregateMetrics.challenge_marker_coverage ?? 0,
    ).toBeGreaterThanOrEqual(
      lockedBaseline.metrics.challenge_marker_coverage ?? 0,
    );
    expect(improved.aggregateMetrics.status_accuracy ?? 0).toBeGreaterThanOrEqual(
      lockedBaseline.metrics.status_accuracy ?? 0,
    );
    expect(
      improved.aggregateMetrics.no_challenge_uncertain_accuracy ?? 0,
    ).toBeGreaterThanOrEqual(
      lockedBaseline.metrics.no_challenge_uncertain_accuracy ?? 0,
    );
    expect(improved.aggregateMetrics.false_positive_rate ?? 1).toBeLessThanOrEqual(
      lockedBaseline.metrics.false_positive_rate ?? 1,
    );
    expect(
      improved.aggregateMetrics.taxonomy_wording_leak_rate ?? 1,
    ).toBeLessThanOrEqual(
      lockedBaseline.metrics.taxonomy_wording_leak_rate ?? 0,
    );
  });

  const holdoutIt = process.env.EVAL_INCLUDE_HOLDOUT === '1' ? it : it.skip;
  holdoutIt(
    'holds evidence-backed challenge extraction on the locked holdout',
    async () => {
      const evalSet = readEvalSetFixture(
        'sem13/sem13_challenge_extractor_holdout.json',
      );
      const report = await runEvalSet<
        Sem13Input,
        ChallengeExtractionResult & { rendered_summary?: string }
      >(evalSet, {
        run: async input => {
          const result = MethodologyChallengeExtractionResultSchema.parse(
            extractMethodologyChallenges(
              input.papers as never[],
              input.critical_results as never[] | undefined,
            ),
          );
          return {
            ...result,
            rendered_summary: renderMethodologyChallenges(result),
          };
        },
        judge: (expected, actual) => {
          const evaluation = evaluateSem13(expected as Sem13Expected, actual);
          return {
            passed: evaluation.passed,
            metrics: { passed: evaluation.passed ? 1 : 0 },
          };
        },
        aggregate: aggregateSem13,
      });

      expect(report.aggregateMetrics.challenge_marker_coverage ?? 0).toBeGreaterThanOrEqual(0.75);
      expect(
        report.aggregateMetrics.no_challenge_uncertain_accuracy ?? 0,
      ).toBeGreaterThanOrEqual(0.8);
      expect(report.aggregateMetrics.taxonomy_wording_leak_rate ?? 1).toBe(0);
    },
  );
});
