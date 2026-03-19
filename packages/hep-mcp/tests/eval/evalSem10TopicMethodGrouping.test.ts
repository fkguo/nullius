import { CollectionSemanticGroupingSchema } from '@autoresearch/shared';
import { describe, expect, it } from 'vitest';
import { loadBaseline, runEvalSet } from '../../src/eval/index.js';
import { groupCollectionSemantics } from '../../src/tools/research/synthesis/collectionSemanticGrouping.js';
import { BASELINES_DIR, readEvalSetFixture } from './evalSnapshots.js';
import {
  aggregateSem10,
  normalizeExpected,
  normalizeGrouping,
  shufflePapers,
  type Sem10Actual,
  type Sem10Expected,
  type Sem10Input,
} from './sem10EvalSupport.js';

describe('eval: SEM-10 topic/method grouping', () => {
  it('treats exact singleton clustering matches as full-credit membership alignment', () => {
    const expected: Sem10Expected = {
      topic_clusters: [['a'], ['b']],
      method_clusters: [['a'], ['b'], ['c']],
    };
    const normalized = normalizeExpected(expected);
    const aggregate = aggregateSem10([
      {
        id: 'singleton_exact_match',
        tags: [],
        input: { papers: [] },
        expected,
        actual: {
          ...normalized,
          fallback_rate: 0,
          permutation_stability: 1,
          public_keyword_leak_rate: 0,
          public_label_leak_rate: 0,
        },
        passed: true,
        metrics: { passed: 1 },
      },
    ]);

    expect(aggregate.topic_pairwise_f1).toBe(1);
    expect(aggregate.method_pairwise_f1).toBe(1);
    expect(aggregate.grouping_f1_overall).toBe(1);
  });

  it('locks grouping quality to membership plus public-keyword anti-leak checks', async () => {
    const evalSet = readEvalSetFixture('sem10/sem10_topic_method_grouping_eval.json');
    const lockedBaseline = loadBaseline(evalSet.name, BASELINES_DIR);
    if (!lockedBaseline) {
      throw new Error(`Missing locked baseline for ${evalSet.name}`);
    }

    const improved = await runEvalSet<Sem10Input, Sem10Actual>(evalSet, {
      run: async input => {
        const base = normalizeGrouping(
          CollectionSemanticGroupingSchema.parse(
            groupCollectionSemantics(input.papers),
          ),
        );
        const stabilities = [1, 2, 3, 4, 5].map(seed => {
          const shuffled = normalizeGrouping(
            CollectionSemanticGroupingSchema.parse(
              groupCollectionSemantics(shufflePapers(input.papers, seed)),
            ),
          );
          const allKeys = Object.keys(base.topic_assignments);
          const matches = allKeys.filter(
            key =>
              base.topic_assignments[key] === shuffled.topic_assignments[key] &&
              base.method_assignments[key] ===
                shuffled.method_assignments[key],
          ).length;
          return matches / Math.max(allKeys.length, 1);
        });
        return {
          ...base,
          permutation_stability:
            stabilities.reduce((sum, value) => sum + value, 0) /
            stabilities.length,
        };
      },
      judge: (expected, actual) => {
        const exp = normalizeExpected(expected as Sem10Expected);
        const pass =
          Object.keys(exp.topic_assignments).every(
            key => exp.topic_assignments[key] === actual.topic_assignments[key],
          ) &&
          Object.keys(exp.method_assignments).every(
            key =>
              exp.method_assignments[key] === actual.method_assignments[key],
          ) &&
          actual.public_keyword_leak_rate === 0 &&
          actual.public_label_leak_rate === 0;
        return { passed: pass, metrics: { passed: pass ? 1 : 0 } };
      },
      aggregate: aggregateSem10,
    });

    expect(improved.aggregateMetrics.grouping_f1_overall ?? 0).toBeGreaterThanOrEqual(
      lockedBaseline.metrics.grouping_f1_overall ?? 0,
    );
    expect(
      improved.aggregateMetrics.permutation_stability_overall ?? 0,
    ).toBeGreaterThanOrEqual(
      lockedBaseline.metrics.permutation_stability_overall ?? 0,
    );
    expect(improved.aggregateMetrics.hard_subset_f1 ?? 0).toBeGreaterThanOrEqual(
      lockedBaseline.metrics.hard_subset_f1 ?? 0,
    );
    expect(
      improved.aggregateMetrics.public_keyword_leak_rate ?? 1,
    ).toBeLessThanOrEqual(
      lockedBaseline.metrics.public_keyword_leak_rate ?? 0,
    );
    expect(
      improved.aggregateMetrics.public_label_leak_rate ?? 1,
    ).toBeLessThanOrEqual(
      lockedBaseline.metrics.public_label_leak_rate ?? 0,
    );
  });

  const holdoutIt = process.env.EVAL_INCLUDE_HOLDOUT === '1' ? it : it.skip;
  holdoutIt('holds grouping quality on the locked holdout', async () => {
    const evalSet = readEvalSetFixture(
      'sem10/sem10_topic_method_grouping_holdout.json',
    );
    const report = await runEvalSet<Sem10Input, Sem10Actual>(evalSet, {
      run: async input => {
        const base = normalizeGrouping(
          CollectionSemanticGroupingSchema.parse(
            groupCollectionSemantics(input.papers),
          ),
        );
        return { ...base, permutation_stability: 1 };
      },
      judge: (expected, actual) => {
        const exp = normalizeExpected(expected as Sem10Expected);
        const pass =
          Object.keys(exp.topic_assignments).every(
            key => exp.topic_assignments[key] === actual.topic_assignments[key],
          ) &&
          Object.keys(exp.method_assignments).every(
            key =>
              exp.method_assignments[key] === actual.method_assignments[key],
          ) &&
          actual.public_keyword_leak_rate === 0 &&
          actual.public_label_leak_rate === 0;
        return { passed: pass, metrics: { passed: pass ? 1 : 0 } };
      },
      aggregate: aggregateSem10,
    });

    expect(report.aggregateMetrics.grouping_f1_overall ?? 0).toBeGreaterThanOrEqual(0.8);
    expect(
      report.aggregateMetrics.permutation_stability_overall ?? 0,
    ).toBeGreaterThanOrEqual(0.85);
    expect(report.aggregateMetrics.public_keyword_leak_rate ?? 1).toBe(0);
    expect(report.aggregateMetrics.public_label_leak_rate ?? 1).toBe(0);
  });
});
