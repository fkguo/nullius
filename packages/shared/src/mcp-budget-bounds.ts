import type { z } from 'zod';

import { walkSchemaPairs, type SchemaPair } from './mcp-required-keys.js';

/**
 * Check that every budget-style numeric field of a published MCP
 * `inputSchema` states the range its parser actually applies.
 *
 * A budget-style field is a preprocess pipe whose output is a number: the
 * shared `optionalBudgetInt` / `optionalBudgetNumber` helpers and stricter
 * variants built the same way. The field is recognised from that structure,
 * not from the bounds metadata the converter publishes, so a field whose
 * metadata was lost is still checked.
 *
 * The reference is the pipe's own parse: a value is accepted when it parses to
 * itself (a budget helper turns a rejected value into undefined; a strict
 * variant fails). For the JSON node paired with the field:
 * - `type` is `integer` exactly when a fractional value inside the range is
 *   rejected (checked whenever the range has nonzero width);
 * - a stated `minimum` / `maximum` is accepted and one step beyond it is
 *   rejected (for integers the nearest integer inside the bound, step 1;
 *   otherwise the bound itself, a relative step of 1e-9);
 * - with no `minimum` / `maximum`, a far value on that side is accepted.
 *
 * Returns one line per disagreement, and one line per place where the JSON
 * structure could not be matched to the Zod structure (as in
 * `findRequiredKeyMismatches`); an empty list means the schema passes.
 */
export function findBudgetBoundMismatches(schema: z.ZodType, inputSchema: unknown): string[] {
  return walkSchemaPairs(schema, inputSchema, checkBudgetBounds);
}

type Def = { type: string; [key: string]: unknown };

function defOf(schema: unknown): Def | undefined {
  return (schema as { _zod?: { def?: Def } } | undefined)?._zod?.def;
}

function budgetPipe(chain: z.ZodType[]): z.ZodType | undefined {
  for (let index = chain.length - 1; index >= 0; index -= 1) {
    const def = defOf(chain[index]);
    if (def?.type === 'pipe' && defOf(def.in)?.type === 'transform') return chain[index];
  }
  return undefined;
}

function checkBudgetBounds({ chain, type, json, mismatch }: SchemaPair): void {
  if (type !== 'number') return;
  const pipe = budgetPipe(chain);
  if (!pipe) return;
  const node = (typeof json === 'object' && json !== null ? json : {}) as Record<string, unknown>;
  const accepts = (value: number) => {
    const result = pipe.safeParse(value);
    return result.success && result.data === value;
  };
  const integer = node.type === 'integer';
  if (!integer && node.type !== 'number') {
    mismatch(`budget field published with type ${JSON.stringify(node.type)}`);
    return;
  }
  const step = (bound: number) => (integer ? 1 : Math.max(1, Math.abs(bound)) * 1e-9);
  const far = integer ? Number.MAX_SAFE_INTEGER : Number.MAX_VALUE / 2;
  const min = typeof node.minimum === 'number' ? node.minimum : undefined;
  const max = typeof node.maximum === 'number' ? node.maximum : undefined;

  // For an integer field the stated bounds admit the integers between them.
  const lowest = min === undefined ? undefined : integer ? Math.ceil(min) : min;
  const highest = max === undefined ? undefined : integer ? Math.floor(max) : max;
  const stated = (word: string, bound: number, endpoint: number) =>
    endpoint === bound ? `stated ${word} ${bound}` : `stated ${word} ${bound} (integer ${endpoint})`;
  if (min !== undefined && lowest !== undefined) {
    if (!accepts(lowest)) mismatch(`${stated('minimum', min, lowest)} is rejected by the parser`);
    const below = lowest - step(lowest);
    if (accepts(below)) mismatch(`parser accepts ${below}, below the ${stated('minimum', min, lowest)}`);
  } else if (!accepts(-far)) {
    mismatch(`no minimum stated, but the parser rejects ${-far}`);
  }
  if (max !== undefined && highest !== undefined) {
    if (!accepts(highest)) mismatch(`${stated('maximum', max, highest)} is rejected by the parser`);
    const above = highest + step(highest);
    if (accepts(above)) mismatch(`parser accepts ${above}, above the ${stated('maximum', max, highest)}`);
  } else if (!accepts(far)) {
    mismatch(`no maximum stated, but the parser rejects ${far}`);
  }

  // A fractional value inside the range tells integer and number apart: a
  // half-integer as close to zero as the range allows (far from zero a
  // half-integer is not representable), else the largest half-integer not
  // above the maximum. A range holding no half-integer is narrower than 1 and
  // lies within (k - 1/2, k + 1/2); its midpoint, or when that is k its
  // quarter point, is then fractional.
  const low = min ?? -Infinity;
  const high = max ?? Infinity;
  const start = Math.min(Math.max(0, low), high);
  const nearZero = Math.floor(start) + 0.5;
  const fraction = [nearZero < low ? nearZero + 1 : nearZero, Math.floor(high - 0.5) + 0.5, (low + high) / 2, low + (high - low) / 4].find(
    value => Number.isFinite(value) && value >= low && value <= high && !Number.isInteger(value),
  );
  if (fraction !== undefined) {
    if (integer && accepts(fraction)) mismatch(`published as integer, but the parser accepts ${fraction}`);
    if (!integer && !accepts(fraction)) mismatch(`published as number, but the parser rejects ${fraction}`);
  }
}
