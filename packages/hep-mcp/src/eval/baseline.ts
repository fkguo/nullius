import * as fs from 'fs';
import * as path from 'path';

import type { EvalReport } from './runner.js';
import type { EvalAggregateOutcome } from './outcome.js';

export type BaselineRecord = {
  evalSetName: string;
  module: string;
  timestamp: string;
  metrics: Record<string, number>;
  aggregateOutcome?: EvalAggregateOutcome;
  evalSetVersion: number;
};

function toFileStem(evalSetName: string): string {
  return evalSetName.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

function baselinePath(evalSetName: string, baselineDir: string): string {
  return path.join(baselineDir, `${toFileStem(evalSetName)}.baseline.json`);
}

export function saveBaseline(report: EvalReport, baselineDir: string): void {
  fs.mkdirSync(baselineDir, { recursive: true });
  const record: BaselineRecord = {
    evalSetName: report.evalSetName,
    module: report.module,
    timestamp: report.timestamp,
    metrics: report.aggregateMetrics,
    aggregateOutcome: report.aggregateOutcome,
    evalSetVersion: report.evalSetVersion,
  };
  fs.writeFileSync(
    baselinePath(report.evalSetName, baselineDir),
    `${JSON.stringify(record, null, 2)}\n`,
    'utf-8',
  );
}

export function loadBaseline(evalSetName: string, baselineDir: string): BaselineRecord | null {
  const filePath = baselinePath(evalSetName, baselineDir);
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as BaselineRecord;
}

export function compareWithBaseline(
  report: EvalReport,
  baseline: BaselineRecord | null,
): {
  deltas: Record<string, { baseline: number; current: number; delta: number; improved: boolean }>;
  aggregateOutcomeDeltas: {
    task_success_rate: { baseline: number; current: number; delta: number; improved: boolean };
    partial_progress_mean: { baseline: number; current: number; delta: number; improved: boolean };
    duration_ms_mean: { baseline: number; current: number; delta: number; improved: boolean };
    cost_usd_mean: { baseline: number | null; current: number | null; delta: number | null; improved: boolean | null };
    token_usage_mean: {
      input_tokens: { baseline: number | null; current: number | null; delta: number | null; improved: boolean | null };
      output_tokens: { baseline: number | null; current: number | null; delta: number | null; improved: boolean | null };
      total_tokens: { baseline: number | null; current: number | null; delta: number | null; improved: boolean | null };
    };
  } | null;
  isFirstRun: boolean;
} {
  if (baseline === null) {
    return {
      deltas: {},
      aggregateOutcomeDeltas: null,
      isFirstRun: true,
    };
  }

  const metricNames = new Set([
    ...Object.keys(baseline.metrics),
    ...Object.keys(report.aggregateMetrics),
  ]);

  const deltas: Record<string, { baseline: number; current: number; delta: number; improved: boolean }> = {};
  for (const name of metricNames) {
    const baselineValue = baseline.metrics[name] ?? 0;
    const currentValue = report.aggregateMetrics[name] ?? 0;
    const deltaValue = currentValue - baselineValue;
    deltas[name] = {
      baseline: baselineValue,
      current: currentValue,
      delta: deltaValue,
      improved: deltaValue >= 0,
    };
  }

  const toDelta = (baselineValue: number, currentValue: number, smallerIsBetter = false) => {
    const delta = currentValue - baselineValue;
    return {
      baseline: baselineValue,
      current: currentValue,
      delta,
      improved: smallerIsBetter ? delta <= 0 : delta >= 0,
    };
  };

  const toNullableDelta = (
    baselineValue: number | null | undefined,
    currentValue: number | null | undefined,
    smallerIsBetter = false,
  ) => {
    const baselineNumber = Number.isFinite(baselineValue) ? Number(baselineValue) : null;
    const currentNumber = Number.isFinite(currentValue) ? Number(currentValue) : null;
    if (baselineNumber === null || currentNumber === null) {
      return { baseline: baselineNumber, current: currentNumber, delta: null, improved: null };
    }
    const delta = currentNumber - baselineNumber;
    return {
      baseline: baselineNumber,
      current: currentNumber,
      delta,
      improved: smallerIsBetter ? delta <= 0 : delta >= 0,
    };
  };

  const aggregateOutcomeDeltas = {
    task_success_rate: toDelta(
      (baseline.aggregateOutcome?.task_success_rate ?? 0),
      report.aggregateOutcome.task_success_rate,
    ),
    partial_progress_mean: toDelta(
      (baseline.aggregateOutcome?.partial_progress_mean ?? 0),
      report.aggregateOutcome.partial_progress_mean,
    ),
    duration_ms_mean: toDelta(
      (baseline.aggregateOutcome?.resource_overhead.duration_ms_mean ?? 0),
      report.aggregateOutcome.resource_overhead.duration_ms_mean,
      true,
    ),
    cost_usd_mean: toNullableDelta(
      baseline.aggregateOutcome?.resource_overhead.cost_usd_mean,
      report.aggregateOutcome.resource_overhead.cost_usd_mean,
      true,
    ),
    token_usage_mean: {
      input_tokens: toNullableDelta(
        baseline.aggregateOutcome?.resource_overhead.token_usage_mean?.input_tokens,
        report.aggregateOutcome.resource_overhead.token_usage_mean?.input_tokens,
        true,
      ),
      output_tokens: toNullableDelta(
        baseline.aggregateOutcome?.resource_overhead.token_usage_mean?.output_tokens,
        report.aggregateOutcome.resource_overhead.token_usage_mean?.output_tokens,
        true,
      ),
      total_tokens: toNullableDelta(
        baseline.aggregateOutcome?.resource_overhead.token_usage_mean?.total_tokens,
        report.aggregateOutcome.resource_overhead.token_usage_mean?.total_tokens,
        true,
      ),
    },
  };

  return {
    deltas,
    aggregateOutcomeDeltas,
    isFirstRun: false,
  };
}
