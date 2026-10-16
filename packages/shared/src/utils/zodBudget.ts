import { z } from 'zod';

type OptionalBudgetOptions = {
  min?: number;
  max?: number;
};

type BudgetSchemaMetadata = OptionalBudgetOptions & {
  integer: boolean;
};

function parseBudgetValue(
  value: unknown,
  { integer, min, max }: OptionalBudgetOptions & { integer: boolean },
): number | undefined {
  let numeric: number | undefined;

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return undefined;
    numeric = value;
  } else if (typeof value === 'string') {
    const compact = value.replace(/\s+/g, '');
    if (compact.length === 0) return undefined;

    const pattern = integer
      ? /^[+-]?\d+$/
      : /^[+-]?(?:\d+\.?\d*|\.\d+)$/;

    if (!pattern.test(compact)) return undefined;

    numeric = Number(compact);
    if (!Number.isFinite(numeric)) return undefined;
  } else {
    return undefined;
  }

  if (integer && !Number.isInteger(numeric)) return undefined;
  if (min !== undefined && numeric < min) return undefined;
  if (max !== undefined && numeric > max) return undefined;

  return numeric;
}

// The parsing pipe is wrapped in an outer optional so that the published
// input schema does not list the field as required: an omitted value parses
// (to undefined, or to the caller's .default()). The pipe itself already
// accepts undefined, so the wrapper does not change what parses. The bounds
// sit on the inner pipe, where the schema converter reads them. Callers only
// ever hold the outer node, so the copies that zod's .describe() and .meta()
// make never replace the pipe and the bounds are always published.
function withBudgetMetadata<T extends z.ZodType>(parsed: T, metadata: BudgetSchemaMetadata) {
  Object.defineProperty(parsed, '__mcpBudget', {
    value: metadata,
    configurable: true,
  });
  return parsed.optional();
}

export function optionalBudgetInt(options: OptionalBudgetOptions = {}) {
  const parsed = z.preprocess(
    value => parseBudgetValue(value, { ...options, integer: true }),
    z.number().int().optional(),
  );
  return withBudgetMetadata(parsed, { ...options, integer: true });
}

export function optionalBudgetNumber(options: OptionalBudgetOptions = {}) {
  const parsed = z.preprocess(
    value => parseBudgetValue(value, { ...options, integer: false }),
    z.number().optional(),
  );
  return withBudgetMetadata(parsed, { ...options, integer: false });
}
