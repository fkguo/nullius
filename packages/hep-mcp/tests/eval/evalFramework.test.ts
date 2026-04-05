import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  compareWithBaseline,
  loadBaseline,
  mrrAtK,
  ndcgAtK,
  recallAtK,
  runEvalSet,
  saveBaseline,
  type EvalCase,
  type EvalSet,
} from '../../src/eval/index.js';
import { readEvalSetFixture } from './evalSnapshots.js';

type DemoInput = { query: string; retrieved_ids: string[] };
type DemoExpected = { expected_evidence_ids: string[] };

function firstRank(evalCase: EvalCase, actual: string[]): number | null {
  const expected = evalCase.expected as DemoExpected;
  if (!Array.isArray(expected.expected_evidence_ids) || expected.expected_evidence_ids.length === 0) {
    return null;
  }
  let best: number | null = null;
  for (const candidateId of expected.expected_evidence_ids) {
    const idx = actual.indexOf(candidateId);
    if (idx >= 0) {
      const rank = idx + 1;
      best = best === null ? rank : Math.min(best, rank);
    }
  }
  return best;
}

async function runDemoEval(evalSet: EvalSet) {
  return runEvalSet<DemoInput, string[]>(evalSet, {
    run: async input => input.retrieved_ids,
    judge: (_expected, actual, evalCase) => {
      const expected = evalCase.expected as DemoExpected;
      const rank = firstRank(evalCase, actual);
      const expectedEmpty =
        Array.isArray(expected.expected_evidence_ids) && expected.expected_evidence_ids.length === 0;
      const passed = expectedEmpty ? actual.length === 0 : rank !== null && rank <= 10;
      const partialProgress = expectedEmpty
        ? (actual.length === 0 ? 1 : 0)
        : (rank === null ? 0 : Math.max(0, Math.min(1, 1 / rank)));
      const tokenUsage = {
        input_tokens: String((evalCase.input as DemoInput).query ?? '').trim().split(/\s+/).filter(Boolean).length,
        output_tokens: actual.length,
        total_tokens: String((evalCase.input as DemoInput).query ?? '').trim().split(/\s+/).filter(Boolean).length
          + actual.length,
      };
      return {
        passed,
        metrics: {
          recall_at_10_case: rank !== null && rank <= 10 ? 1 : 0,
          mrr_at_10_case: rank !== null && rank <= 10 ? 1 / rank : 0,
        },
        outcome: {
          task_success: passed,
          partial_progress: partialProgress,
        },
        resource_overhead: {
          token_usage: tokenUsage,
          cost_usd: null,
        },
      };
    },
    aggregate: results => {
      const ranks: Array<number | null> = [];
      for (const result of results) {
        const evalCase = evalSet.cases.find(c => c.id === result.caseId);
        if (!evalCase) continue;
        const expected = evalCase.expected as DemoExpected;
        if (!Array.isArray(expected.expected_evidence_ids) || expected.expected_evidence_ids.length === 0) {
          continue;
        }
        const actual = Array.isArray(result.actual) ? result.actual : [];
        ranks.push(firstRank(evalCase, actual));
      }
      return {
        recall_at_10: recallAtK(ranks, 10),
        mrr_at_10: mrrAtK(ranks, 10),
      };
    },
  });
}

describe('eval framework: demo retrieval eval set', () => {
  const evalSet = readEvalSetFixture('demo_retrieval_eval.json');

  it('loads and validates demo eval set against EvalSetSchema', () => {
    expect(evalSet.name).toBe('demo_retrieval');
    expect(evalSet.module).toBe('SEM-00');
    expect(evalSet.cases.length).toBeGreaterThanOrEqual(10);
  });

  it('runs demo eval set through runner and produces EvalReport', async () => {
    const report = await runDemoEval(evalSet);
    expect(report.evalSetName).toBe(evalSet.name);
    expect(report.module).toBe(evalSet.module);
    expect(report.evalSetVersion).toBe(evalSet.version);
    expect(report.summary.total).toBe(evalSet.cases.length);
    expect(report.caseResults).toHaveLength(evalSet.cases.length);
    expect(report.summary.taskSuccessRate).toBeCloseTo(report.summary.passRate, 6);
    expect(report.summary.partialProgressMean).toBeGreaterThanOrEqual(0);
    expect(report.summary.partialProgressMean).toBeLessThanOrEqual(1);
    expect(report.summary.resourceOverhead.durationMsAvg).toBeGreaterThanOrEqual(0);
    expect(report.summary.resourceOverhead.tokenUsageAvg?.total_tokens ?? 0).toBeGreaterThan(0);
  });

  it('computes nDCG@k for ranked binary relevance lists', () => {
    expect(ndcgAtK([1, 0, 0], 10)).toBeCloseTo(1, 6);
    expect(ndcgAtK([0, 1, 0], 10)).toBeCloseTo(1 / Math.log2(3), 6);
  });

  it('computes aggregate metrics (recall@10, MRR@10)', async () => {
    const report = await runDemoEval(evalSet);
    expect(report.aggregateMetrics.recall_at_10).toBeCloseTo(0.75, 6);
    expect(report.aggregateMetrics.mrr_at_10).toBeCloseTo(0.4947916667, 6);
    expect(report.aggregateOutcome.task_success_rate).toBeCloseTo(report.summary.taskSuccessRate, 6);
    expect(report.aggregateOutcome.partial_progress_mean).toBeCloseTo(report.summary.partialProgressMean, 6);
    expect(report.aggregateOutcome.resource_overhead.duration_ms_mean).toBeGreaterThanOrEqual(0);
  });

  it('saves and loads baseline', async () => {
    const report = await runDemoEval(evalSet);
    const baselineDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hep-eval-baseline-'));
    try {
      saveBaseline(report, baselineDir);
      const baseline = loadBaseline(evalSet.name, baselineDir);
      expect(baseline).toBeTruthy();
      expect(baseline?.evalSetName).toBe(evalSet.name);
      expect(baseline?.evalSetVersion).toBe(evalSet.version);
      expect(baseline?.metrics.recall_at_10).toBeCloseTo(0.75, 6);
      expect(baseline?.aggregateOutcome?.task_success_rate ?? 0).toBeGreaterThan(0);
    } finally {
      fs.rmSync(baselineDir, { recursive: true, force: true });
    }
  });

  it('compares with baseline and detects delta', async () => {
    const report = await runDemoEval(evalSet);
    const baselineDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hep-eval-baseline-'));
    try {
      saveBaseline(report, baselineDir);
      const baseline = loadBaseline(evalSet.name, baselineDir);
      const same = compareWithBaseline(report, baseline);
      expect(same.isFirstRun).toBe(false);
      expect(same.deltas.recall_at_10?.delta ?? NaN).toBeCloseTo(0, 9);
      expect(same.deltas.mrr_at_10?.delta ?? NaN).toBeCloseTo(0, 9);
      expect(same.aggregateOutcomeDeltas?.task_success_rate.delta ?? NaN).toBeCloseTo(0, 9);
      expect(same.aggregateOutcomeDeltas?.partial_progress_mean.delta ?? NaN).toBeCloseTo(0, 9);
      expect(same.aggregateOutcomeDeltas?.duration_ms_mean.delta ?? NaN).toBeCloseTo(0, 9);

      const regressedReport = {
        ...report,
        aggregateMetrics: {
          ...report.aggregateMetrics,
          recall_at_10: report.aggregateMetrics.recall_at_10 - 0.125,
        },
        aggregateOutcome: {
          ...report.aggregateOutcome,
          resource_overhead: {
            ...report.aggregateOutcome.resource_overhead,
            duration_ms_mean: report.aggregateOutcome.resource_overhead.duration_ms_mean + 10,
          },
        },
      };
      const regression = compareWithBaseline(regressedReport, baseline);
      expect(regression.deltas.recall_at_10?.delta ?? 0).toBeLessThan(0);
      expect(regression.deltas.recall_at_10?.improved).toBe(false);
      expect(regression.aggregateOutcomeDeltas?.duration_ms_mean.delta ?? 0).toBeGreaterThan(0);
      expect(regression.aggregateOutcomeDeltas?.duration_ms_mean.improved).toBe(false);

      const fasterReport = {
        ...report,
        aggregateOutcome: {
          ...report.aggregateOutcome,
          resource_overhead: {
            ...report.aggregateOutcome.resource_overhead,
            duration_ms_mean: Math.max(0, report.aggregateOutcome.resource_overhead.duration_ms_mean - 10),
          },
        },
      };
      const faster = compareWithBaseline(fasterReport, baseline);
      expect(faster.aggregateOutcomeDeltas?.duration_ms_mean.delta ?? 0).toBeLessThanOrEqual(0);
      expect(faster.aggregateOutcomeDeltas?.duration_ms_mean.improved).toBe(true);

      const firstRun = compareWithBaseline(report, null);
      expect(firstRun.isFirstRun).toBe(true);
    } finally {
      fs.rmSync(baselineDir, { recursive: true, force: true });
    }
  });
});
