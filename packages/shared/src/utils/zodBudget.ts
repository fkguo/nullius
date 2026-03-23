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

export function optionalBudgetInt(options: OptionalBudgetOptions = {}) {
  const schema = z.preprocess(
    value => parseBudgetValue(value, { ...options, integer: true }),
    z.number().int().optional(),
  );
  Object.defineProperty(schema, '__mcpBudget', {
    value: { ...options, integer: true } satisfies BudgetSchemaMetadata,
    configurable: true,
  });
  return schema;
}

export function optionalBudgetNumber(options: OptionalBudgetOptions = {}) {
  const schema = z.preprocess(
    value => parseBudgetValue(value, { ...options, integer: false }),
    z.number().optional(),
  );
  Object.defineProperty(schema, '__mcpBudget', {
    value: { ...options, integer: false } satisfies BudgetSchemaMetadata,
    configurable: true,
  });
  return schema;
}
