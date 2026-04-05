export type EvalTokenUsage = {
  input_tokens: number | null;
  output_tokens: number | null;
  total_tokens: number | null;
};

export type EvalResourceOverhead = {
  duration_ms: number;
  token_usage: EvalTokenUsage | null;
  cost_usd: number | null;
};

export type EvalOutcome = {
  task_success: boolean;
  partial_progress: number;
};

export type EvalAggregateOutcome = {
  task_success_rate: number;
  partial_progress_mean: number;
  resource_overhead: {
    duration_ms_mean: number;
    token_usage_mean: EvalTokenUsage | null;
    cost_usd_mean: number | null;
  };
};

export function clampPartialProgress(value: unknown, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  const numeric = Number(value);
  return Math.max(0, Math.min(1, numeric));
}

export function normalizeNullableNumber(value: unknown): number | null {
  return Number.isFinite(value) ? Number(value) : null;
}

export function normalizeTokenUsage(value: Partial<EvalTokenUsage> | null | undefined): EvalTokenUsage | null {
  if (!value || typeof value !== 'object') return null;
  return {
    input_tokens: normalizeNullableNumber(value.input_tokens),
    output_tokens: normalizeNullableNumber(value.output_tokens),
    total_tokens: normalizeNullableNumber(value.total_tokens),
  };
}

function meanFinite(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function meanNullable(values: Array<number | null>): number | null {
  const observed = values.filter((value): value is number => value !== null && Number.isFinite(value));
  if (observed.length === 0) return null;
  return meanFinite(observed);
}

export function computeAggregateOutcome<
  TResult extends { outcome: EvalOutcome; resource_overhead: EvalResourceOverhead },
>(results: TResult[]): EvalAggregateOutcome {
  const taskSuccessRate = meanFinite(results.map(result => (result.outcome.task_success ? 1 : 0)));
  const partialProgressMean = meanFinite(results.map(result => result.outcome.partial_progress));
  const durationMsMean = meanFinite(results.map(result => result.resource_overhead.duration_ms));
  const inputTokensMean = meanNullable(results.map(result => result.resource_overhead.token_usage?.input_tokens ?? null));
  const outputTokensMean = meanNullable(
    results.map(result => result.resource_overhead.token_usage?.output_tokens ?? null),
  );
  const totalTokensMean = meanNullable(results.map(result => result.resource_overhead.token_usage?.total_tokens ?? null));
  const costUsdMean = meanNullable(results.map(result => result.resource_overhead.cost_usd));
  const hasAnyTokenUsage = inputTokensMean !== null || outputTokensMean !== null || totalTokensMean !== null;

  return {
    task_success_rate: taskSuccessRate,
    partial_progress_mean: partialProgressMean,
    resource_overhead: {
      duration_ms_mean: durationMsMean,
      token_usage_mean: hasAnyTokenUsage
        ? {
            input_tokens: inputTokensMean,
            output_tokens: outputTokensMean,
            total_tokens: totalTokensMean,
          }
        : null,
      cost_usd_mean: costUsdMean,
    },
  };
}
