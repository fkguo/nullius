import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { compareWithBaseline, loadBaseline, runEvalSet, saveBaseline, type EvalResult } from '../../src/eval/index.js';
import { BASELINES_DIR, readEvalSetFixture } from './evalSnapshots.js';
import {
  aggregateSem06fBaseline,
  aggregateSem06fImproved,
  runSem06fCase,
  setupSem06fFixtures,
} from './sem06fEvalHarness.js';
import type { Sem06fActual, Sem06fExpected, Sem06fInput } from './sem06fEvalSupport.js';

describe('eval: SEM-06f multimodal scientific retrieval', () => {
  let dataDir: string;
  let originalDataDirEnv: string | undefined;

  beforeEach(() => {
    originalDataDirEnv = process.env.HEP_DATA_DIR;
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hep-eval-sem06f-data-'));
    process.env.HEP_DATA_DIR = dataDir;
  });

  afterEach(() => {
    if (originalDataDirEnv !== undefined) process.env.HEP_DATA_DIR = originalDataDirEnv;
    else delete process.env.HEP_DATA_DIR;
    delete process.env.HEP_ENABLE_MULTIMODAL_RETRIEVAL;
    if (fs.existsSync(dataDir)) fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('improves page-native retrieval while keeping text-first and failure paths fail-closed', async () => {
    const evalSet = readEvalSetFixture('sem06f_multimodal_scientific_retrieval_eval.json');
    const fixtures = await setupSem06fFixtures();
    try {
      const baseline = await runEvalSet<Sem06fInput, Sem06fActual>(evalSet, {
        run: async (input, evalCase) => runSem06fCase(fixtures, input, evalCase.expected as Sem06fExpected, true),
        judge: (_expected, actual) => ({ passed: actual.topUnit !== null, metrics: { baseline_ready: actual.topUnit ? 1 : 0 } }),
        aggregate: aggregateSem06fBaseline,
      });

      const improved = await runEvalSet<Sem06fInput, Sem06fActual>(evalSet, {
        run: async (input, evalCase) => runSem06fCase(fixtures, input, evalCase.expected as Sem06fExpected, false),
        judge: (expected, actual) => {
          const exp = expected as Sem06fExpected;
          const passed = actual.topUnit === exp.top_unit
            && actual.topStatus === exp.top_status
            && actual.availability === exp.availability
            && actual.topPreviewMatches
            && actual.multimodalStatus === exp.multimodal_status;
          return { passed, metrics: { passed: passed ? 1 : 0 } };
        },
        aggregate: aggregateSem06fImproved,
      });

      expect(improved.aggregateMetrics.page_native_hit_rate ?? 0).toBeGreaterThan(baseline.aggregateMetrics.page_native_hit_rate ?? 0);
      expect(improved.aggregateMetrics.failure_path_rate ?? 0).toBeGreaterThanOrEqual(1);
      expect(improved.aggregateMetrics.text_non_regression_rate ?? 0).toBeGreaterThanOrEqual(1);
      expect(improved.aggregateMetrics.applied_rate ?? 0).toBeGreaterThanOrEqual(1);
      expect(improved.aggregateMetrics.avg_visual_candidates_scanned ?? 0).toBeGreaterThan(0);

      if (process.env.EVAL_UPDATE_BASELINES === '1') saveBaseline(improved, BASELINES_DIR);
      const saved = loadBaseline(evalSet.name, BASELINES_DIR);
      const comparison = compareWithBaseline(improved, saved);
      expect(comparison.isFirstRun).toBe(false);
    } finally {
      if (fs.existsSync(fixtures.tmpDir)) fs.rmSync(fixtures.tmpDir, { recursive: true, force: true });
    }
  });

  const holdoutIt = process.env.EVAL_INCLUDE_HOLDOUT === '1' ? it : it.skip;
  holdoutIt('holds figure/table/equation phrasing on a locked holdout', async () => {
    const evalSet = readEvalSetFixture('sem06f_multimodal_scientific_retrieval_holdout.json');
    const fixtures = await setupSem06fFixtures();
    try {
      const report = await runEvalSet<Sem06fInput, Sem06fActual>(evalSet, {
        run: async (input, evalCase) => runSem06fCase(fixtures, input, evalCase.expected as Sem06fExpected, false),
        judge: (expected, actual) => {
          const exp = expected as Sem06fExpected;
          const passed = actual.topUnit === exp.top_unit
            && actual.topStatus === exp.top_status
            && actual.availability === exp.availability
            && actual.topPreviewMatches
            && actual.multimodalStatus === exp.multimodal_status;
          return { passed, metrics: { passed: passed ? 1 : 0 } };
        },
        aggregate: aggregateSem06fImproved,
      });

      expect(report.summary.passRate).toBeGreaterThanOrEqual(0.95);
      expect(report.aggregateMetrics.page_native_hit_rate ?? 0).toBeGreaterThanOrEqual(0.75);
      expect(report.aggregateMetrics.text_non_regression_rate ?? 0).toBeGreaterThanOrEqual(1);
    } finally {
      if (fs.existsSync(fixtures.tmpDir)) fs.rmSync(fixtures.tmpDir, { recursive: true, force: true });
    }
  });
});
