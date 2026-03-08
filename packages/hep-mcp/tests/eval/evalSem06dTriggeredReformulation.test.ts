import { describe, expect, it } from 'vitest';

import { compareWithBaseline, loadBaseline, runEvalSet } from '../../src/eval/index.js';
import { runFederatedDiscovery } from '../../src/tools/research/federatedDiscovery.js';
import { BASELINES_DIR, readEvalSetFixture } from './evalSnapshots.js';
import {
  aggregateSem06d,
  buildAssessQuery,
  buildCreateMessage,
  buildExecutors,
  judgeSem06d,
  type Sem06dActual,
  type Sem06dInput,
} from './sem06dEvalSupport.js';

describe('NEW-SEM-06d triggered reformulation eval', () => {
  it('locks triggered reformulation + QPP metrics against the baseline', async () => {
    const evalSet = readEvalSetFixture('sem06d_triggered_reformulation_eval.json');
    const report = await runEvalSet<Sem06dInput, Sem06dActual>(evalSet, {
      run: async input => runFederatedDiscovery({
        query: input.query,
        intent: input.intent,
        limit: 10,
        executors: buildExecutors(input),
        createMessage: buildCreateMessage(input),
        assessQuery: buildAssessQuery(input),
        maxReformulationSamplingCalls: input.budget?.max_sampling_calls,
      }),
      judge: (expected, actual) => judgeSem06d(expected, actual),
      aggregate: aggregateSem06d,
    });

    const baseline = loadBaseline(evalSet.name, BASELINES_DIR);
    const comparison = compareWithBaseline(report, baseline);

    expect(report.summary.failed).toBe(0);
    expect(report.aggregateMetrics.hard_query_recall_at_3).toBeGreaterThanOrEqual(1);
    expect(report.aggregateMetrics.easy_query_no_trigger_rate).toBe(1);
    expect(report.aggregateMetrics.exact_id_no_trigger_rate).toBe(1);
    expect(report.aggregateMetrics.useful_trigger_rate).toBeGreaterThanOrEqual(1);
    expect(report.aggregateMetrics.failure_path_guard_overall).toBe(1);
    expect(report.aggregateMetrics.avg_sampling_calls_per_query).toBeLessThanOrEqual(0.5);
    expect(comparison.isFirstRun).toBe(false);
    expect(report.aggregateMetrics.cost_efficiency_overall).toBeGreaterThanOrEqual(baseline.metrics.cost_efficiency_overall);
  });

  const holdoutIt = process.env.EVAL_INCLUDE_HOLDOUT === '1' ? it : it.skip;

  holdoutIt('passes the holdout triggered reformulation slice', async () => {
    const evalSet = readEvalSetFixture('sem06d_triggered_reformulation_holdout.json');
    const report = await runEvalSet<Sem06dInput, Sem06dActual>(evalSet, {
      run: async input => runFederatedDiscovery({
        query: input.query,
        intent: input.intent,
        limit: 10,
        executors: buildExecutors(input),
        createMessage: buildCreateMessage(input),
        assessQuery: buildAssessQuery(input),
        maxReformulationSamplingCalls: input.budget?.max_sampling_calls,
      }),
      judge: (expected, actual) => judgeSem06d(expected, actual),
      aggregate: aggregateSem06d,
    });

    expect(report.summary.failed).toBe(0);
    expect(report.aggregateMetrics.trigger_decision_accuracy ?? 0).toBeGreaterThanOrEqual(1);
    expect(report.aggregateMetrics.hard_query_mrr_at_10 ?? 0).toBeGreaterThan(0.6);
    expect(report.aggregateMetrics.avg_sampling_calls_per_query ?? 0).toBeLessThanOrEqual(0.5);
  });
});
