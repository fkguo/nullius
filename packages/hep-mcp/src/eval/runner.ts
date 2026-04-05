import { EvalSetSchema, type EvalCase, type EvalSet } from './schema.js';
import {
  clampPartialProgress,
  computeAggregateOutcome,
  normalizeNullableNumber,
  normalizeTokenUsage,
  type EvalAggregateOutcome,
  type EvalOutcome,
  type EvalResourceOverhead,
  type EvalTokenUsage,
} from './outcome.js';
export type EvalResult<TOutput = unknown> = {
  caseId: string;
  input: unknown;
  expected: unknown;
  actual: TOutput | null;
  metrics: Record<string, number>;
  outcome: EvalOutcome;
  resource_overhead: EvalResourceOverhead;
  tags: string[];
  passed: boolean;
  durationMs: number;
  error?: string;
};
export type EvalReport<TOutput = unknown> = {
  evalSetName: string;
  evalSetVersion: number;
  module: string;
  timestamp: string;
  aggregateMetrics: Record<string, number>;
  aggregateOutcome: EvalAggregateOutcome;
  caseResults: Array<EvalResult<TOutput>>;
  summary: {
    total: number;
    passed: number;
    failed: number;
    passRate: number;
    taskSuccessRate: number;
    partialProgressMean: number;
    resourceOverhead: {
      durationMsAvg: number;
      tokenUsageAvg: EvalTokenUsage | null;
      costUsdAvg: number | null;
    };
  };
};
export type EvalConfig<TInput, TOutput> = {
  run: (input: TInput, evalCase: EvalCase) => Promise<TOutput> | TOutput;
  judge: (expected: unknown, actual: TOutput, evalCase: EvalCase) => {
    passed: boolean;
    metrics: Record<string, number>;
    outcome?: Partial<EvalOutcome>;
    resource_overhead?: {
      token_usage?: Partial<EvalTokenUsage> | null;
      cost_usd?: number | null;
    };
  };
  aggregate?: (results: Array<EvalResult<TOutput>>) => Record<string, number>;
  timeoutMs?: number;
};
function createTimeoutError(timeoutMs: number): Error {
  return new Error(`Eval case timed out after ${timeoutMs}ms`);
}

async function runWithTimeout<T>(promise: Promise<T>, timeoutMs?: number): Promise<T> {
  if (timeoutMs === undefined || timeoutMs <= 0) {
    return promise;
  }
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<T>((_, reject) => {
    timeoutHandle = setTimeout(() => reject(createTimeoutError(timeoutMs)), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeoutHandle !== undefined) {
      clearTimeout(timeoutHandle);
    }
  }
}

function defaultAggregate<TOutput>(results: Array<EvalResult<TOutput>>): Record<string, number> {
  if (results.length === 0) return {};
  const sums = new Map<string, { total: number; count: number }>();
  for (const result of results) {
    for (const [name, value] of Object.entries(result.metrics)) {
      if (!Number.isFinite(value)) continue;
      const prev = sums.get(name);
      if (prev) {
        prev.total += value;
        prev.count += 1;
      } else {
        sums.set(name, { total: value, count: 1 });
      }
    }
  }

  const aggregated: Record<string, number> = {};
  for (const [name, { total, count }] of sums.entries()) {
    aggregated[name] = count > 0 ? total / count : 0;
  }
  return aggregated;
}
function toErrorMessage(value: unknown): string {
  if (value instanceof Error) return value.message;
  return String(value);
}
function isTimeoutError(value: unknown): boolean {
  return value instanceof Error && value.message.startsWith('Eval case timed out after ');
}

export async function runEvalSet<TInput, TOutput>(
  evalSet: EvalSet,
  config: EvalConfig<TInput, TOutput>,
): Promise<EvalReport<TOutput>> {
  const parsedEvalSet = EvalSetSchema.parse(evalSet);
  const caseResults: Array<EvalResult<TOutput>> = [];
  for (const evalCase of parsedEvalSet.cases) {
    const started = Date.now();
    try {
      const actual = await runWithTimeout(
        Promise.resolve(config.run(evalCase.input as TInput, evalCase)),
        config.timeoutMs,
      );
      const judged = config.judge(evalCase.expected, actual, evalCase);
      const durationMs = Date.now() - started;
      const fallbackTaskSuccess = judged.passed;
      const outcome: EvalOutcome = {
        task_success: judged.outcome?.task_success ?? fallbackTaskSuccess,
        partial_progress: clampPartialProgress(
          judged.outcome?.partial_progress,
          fallbackTaskSuccess ? 1 : 0,
        ),
      };
      caseResults.push({
        caseId: evalCase.id,
        input: evalCase.input,
        expected: evalCase.expected,
        actual,
        metrics: judged.metrics,
        outcome,
        resource_overhead: {
          duration_ms: durationMs,
          token_usage: normalizeTokenUsage(judged.resource_overhead?.token_usage),
          cost_usd: normalizeNullableNumber(judged.resource_overhead?.cost_usd),
        },
        tags: evalCase.tags,
        passed: judged.passed,
        durationMs,
      });
    } catch (error) {
      const timeout = isTimeoutError(error);
      const durationMs = Date.now() - started;
      caseResults.push({
        caseId: evalCase.id,
        input: evalCase.input,
        expected: evalCase.expected,
        actual: null,
        metrics: timeout ? { runtime_error: 1, timeout: 1 } : { runtime_error: 1, timeout: 0 },
        outcome: { task_success: false, partial_progress: 0 },
        resource_overhead: {
          duration_ms: durationMs,
          token_usage: null,
          cost_usd: null,
        },
        tags: evalCase.tags,
        passed: false,
        durationMs,
        error: toErrorMessage(error),
      });
    }
  }
  const passed = caseResults.filter(result => result.passed).length;
  const failed = caseResults.length - passed;
  const aggregateMetrics = config.aggregate ? config.aggregate(caseResults) : defaultAggregate(caseResults);
  const aggregateOutcome = computeAggregateOutcome(caseResults);

  return {
    evalSetName: parsedEvalSet.name,
    evalSetVersion: parsedEvalSet.version,
    module: parsedEvalSet.module,
    timestamp: new Date().toISOString(),
    aggregateMetrics,
    aggregateOutcome,
    caseResults,
    summary: {
      total: caseResults.length,
      passed,
      failed,
      passRate: caseResults.length > 0 ? passed / caseResults.length : 0,
      taskSuccessRate: aggregateOutcome.task_success_rate,
      partialProgressMean: aggregateOutcome.partial_progress_mean,
      resourceOverhead: {
        durationMsAvg: aggregateOutcome.resource_overhead.duration_ms_mean,
        tokenUsageAvg: aggregateOutcome.resource_overhead.token_usage_mean,
        costUsdAvg: aggregateOutcome.resource_overhead.cost_usd_mean,
      },
    },
  };
}
