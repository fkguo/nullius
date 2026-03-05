import { EvalSetSchema, type EvalCase, type EvalSet } from './schema.js';

export type EvalResult<TOutput = unknown> = {
  caseId: string;
  input: unknown;
  expected: unknown;
  actual: TOutput | null;
  metrics: Record<string, number>;
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
  caseResults: Array<EvalResult<TOutput>>;
  summary: {
    total: number;
    passed: number;
    failed: number;
    passRate: number;
  };
};

export type EvalConfig<TInput, TOutput> = {
  run: (input: TInput, evalCase: EvalCase) => Promise<TOutput> | TOutput;
  judge: (expected: unknown, actual: TOutput, evalCase: EvalCase) => {
    passed: boolean;
    metrics: Record<string, number>;
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
      caseResults.push({
        caseId: evalCase.id,
        input: evalCase.input,
        expected: evalCase.expected,
        actual,
        metrics: judged.metrics,
        tags: evalCase.tags,
        passed: judged.passed,
        durationMs: Date.now() - started,
      });
    } catch (error) {
      const timeout = isTimeoutError(error);
      caseResults.push({
        caseId: evalCase.id,
        input: evalCase.input,
        expected: evalCase.expected,
        actual: null,
        metrics: timeout ? { runtime_error: 1, timeout: 1 } : { runtime_error: 1, timeout: 0 },
        tags: evalCase.tags,
        passed: false,
        durationMs: Date.now() - started,
        error: toErrorMessage(error),
      });
    }
  }

  const passed = caseResults.filter(result => result.passed).length;
  const failed = caseResults.length - passed;
  const aggregateMetrics = config.aggregate ? config.aggregate(caseResults) : defaultAggregate(caseResults);

  return {
    evalSetName: parsedEvalSet.name,
    evalSetVersion: parsedEvalSet.version,
    module: parsedEvalSet.module,
    timestamp: new Date().toISOString(),
    aggregateMetrics,
    caseResults,
    summary: {
      total: caseResults.length,
      passed,
      failed,
      passRate: caseResults.length > 0 ? passed / caseResults.length : 0,
    },
  };
}
