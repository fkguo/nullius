import { describe, expect, it } from 'vitest';

import { compareWithBaseline, loadBaseline, runEvalSet } from '../../src/eval/index.js';
import { runFederatedDiscovery } from '../../src/tools/research/federatedDiscovery.js';
import { BASELINES_DIR, readEvalSetFixture } from './evalSnapshots.js';
import { aggregateSem06b, buildCreateMessage, buildExecutors, judgeSem06b, type Sem06bActual, type Sem06bInput } from './sem06bEvalSupport.js';

describe('NEW-SEM-06b hybrid discovery eval', () => {
  it('locks hybrid candidate generation + reranker metrics against the baseline', async () => {
    const evalSet = readEvalSetFixture('sem06b_hybrid_discovery_eval.json');
    const report = await runEvalSet<Sem06bInput, Sem06bActual>(evalSet, {
      run: async input => runFederatedDiscovery({
        query: input.query,
        intent: input.intent,
        limit: 10,
        executors: buildExecutors(input),
        createMessage: buildCreateMessage(input),
      }),
      judge: (expected, actual) => judgeSem06b(expected, actual),
      aggregate: aggregateSem06b,
    });

    const baseline = loadBaseline(evalSet.name, BASELINES_DIR);
    const comparison = compareWithBaseline(report, baseline);

    expect(report.summary.failed).toBe(0);
    expect(report.aggregateMetrics.failure_path_guard_overall).toBe(1);
    expect(report.aggregateMetrics.recall_at_3_hard_query).toBeGreaterThanOrEqual(1);
    expect(comparison.isFirstRun).toBe(false);
    expect(Object.values(comparison.deltas).every(delta => delta.current >= delta.baseline)).toBe(true);
  });

  const holdoutIt = process.env.EVAL_INCLUDE_HOLDOUT === '1' ? it : it.skip;

  holdoutIt('passes the holdout hybrid retrieval slice', async () => {
    const evalSet = readEvalSetFixture('sem06b_hybrid_discovery_holdout.json');
    const report = await runEvalSet<Sem06bInput, Sem06bActual>(evalSet, {
      run: async input => runFederatedDiscovery({
        query: input.query,
        intent: input.intent,
        limit: 10,
        executors: buildExecutors(input),
        createMessage: buildCreateMessage(input),
      }),
      judge: (expected, actual) => judgeSem06b(expected, actual),
      aggregate: aggregateSem06b,
    });

    expect(report.summary.failed).toBe(0);
    expect(report.aggregateMetrics.failure_path_guard_overall ?? 0).toBeGreaterThanOrEqual(1);
    expect(report.aggregateMetrics.mrr_at_10_overall ?? 0).toBeGreaterThan(0.7);
  });
});
