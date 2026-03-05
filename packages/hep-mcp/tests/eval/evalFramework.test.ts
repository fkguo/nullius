import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  compareWithBaseline,
  loadBaseline,
  mrrAtK,
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
      return {
        passed,
        metrics: {
          recall_at_10_case: rank !== null && rank <= 10 ? 1 : 0,
          mrr_at_10_case: rank !== null && rank <= 10 ? 1 / rank : 0,
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
  });

  it('computes aggregate metrics (recall@10, MRR@10)', async () => {
    const report = await runDemoEval(evalSet);
    expect(report.aggregateMetrics.recall_at_10).toBeCloseTo(0.75, 6);
    expect(report.aggregateMetrics.mrr_at_10).toBeCloseTo(0.4947916667, 6);
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

      const regressedReport = {
        ...report,
        aggregateMetrics: {
          ...report.aggregateMetrics,
          recall_at_10: report.aggregateMetrics.recall_at_10 - 0.125,
        },
      };
      const regression = compareWithBaseline(regressedReport, baseline);
      expect(regression.deltas.recall_at_10?.delta ?? 0).toBeLessThan(0);
      expect(regression.deltas.recall_at_10?.improved).toBe(false);

      const firstRun = compareWithBaseline(report, null);
      expect(firstRun.isFirstRun).toBe(true);
    } finally {
      fs.rmSync(baselineDir, { recursive: true, force: true });
    }
  });
});
