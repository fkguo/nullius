import * as fs from 'fs';
import * as path from 'path';

import type { EvalReport } from './runner.js';

export type BaselineRecord = {
  evalSetName: string;
  module: string;
  timestamp: string;
  metrics: Record<string, number>;
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
  isFirstRun: boolean;
} {
  if (baseline === null) {
    return {
      deltas: {},
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

  return {
    deltas,
    isFirstRun: false,
  };
}
