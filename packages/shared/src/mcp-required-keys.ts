import { z } from 'zod';

/**
 * Check the `required` lists of a published MCP `inputSchema` against what
 * the Zod schema it was derived from actually accepts.
 *
 * For every object in the Zod schema (nested objects included, through
 * optional/default/nullable wrappers, arrays, tuples, records, unions and
 * intersections), a key must appear in the matching JSON object's `required`
 * list exactly when an object holding only that key rejects its omission:
 * `z.object({ [key]: shape[key] }).safeParse({})` fails. A record with
 * enumerated keys is checked the same way, one key at a time. The reference is
 * the parser itself, not the converter, so a converter that marks an omissible
 * key required (or the reverse) is caught. Object-level refinements that tie
 * keys together are outside this per-key rule.
 *
 * Returns one line per disagreement, and one line per place where the JSON
 * structure could not be matched to the Zod structure; an empty list means the
 * schema passes. Two forms can be reported as unmatched although the converter
 * handles them: a loose record with regex keys (emitted as patternProperties)
 * and an annotated intersection nested inside a chain of intersections.
 */
export function findRequiredKeyMismatches(schema: z.ZodType, inputSchema: unknown): string[] {
  return walkSchemaPairs(schema, inputSchema, checkRequiredKeys);
}

/** One Zod node paired with the JSON node the converter emitted for it. */
export type SchemaPair = {
  /** The nodes passed on the way in: the node as declared, its wrappers, then `node`. */
  chain: z.ZodType[];
  node: z.ZodType;
  type: string;
  json: unknown;
  mismatch: (what: string) => void;
};

/**
 * Walk a Zod schema and the JSON Schema emitted for it side by side, calling
 * `check` on every pair, and return the check's reports together with one line
 * per place where the JSON structure could not be matched to the Zod structure.
 */
export function walkSchemaPairs(schema: z.ZodType, inputSchema: unknown, check: (pair: SchemaPair) => void): string[] {
  const issues: string[] = [];
  visit(schema, inputSchema, '$', issues, new Map(), check);
  return issues;
}

function checkRequiredKeys({ type, node, json, mismatch }: SchemaPair): void {
  if (!isRecord(json)) return;
  const def = defOf(node)!;
  if (type === 'object' && isRecord(json.properties)) {
    const shape = def.shape as Record<string, z.ZodType>;
    compareRequired(json, Object.keys(shape).filter(key => !z.object({ [key]: shape[key] }).safeParse({}).success), mismatch);
  }
  if (type === 'record' && isRecord(json.additionalProperties)) {
    const keyValues = (def.keyType as { _zod?: { values?: Set<unknown> } })._zod?.values;
    if (!keyValues) return;
    const valueType = def.valueType as z.ZodType;
    const keys = [...keyValues].filter((key): key is string | number => typeof key === 'string' || typeof key === 'number');
    compareRequired(json, keys.filter(key => !z.record(z.literal(key), valueType).safeParse({}).success).map(String), mismatch);
  }
}

type ZodDef = { type: string; [key: string]: unknown };

function defOf(schema: unknown): ZodDef | undefined {
  return (schema as { _zod?: { def?: ZodDef } } | undefined)?._zod?.def;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// Wrappers whose JSON form is the wrapped schema's JSON form (plus annotations
// such as `default`), seen from the input side as the converter emits it.
function unwrap(schema: z.ZodType): z.ZodType {
  const chain = unwrapChain(schema);
  return chain[chain.length - 1];
}

function unwrapChain(schema: z.ZodType): z.ZodType[] {
  const chain = [schema];
  let current = schema;
  for (let depth = 0; depth < 64; depth += 1) {
    const def = defOf(current);
    if (!def) return chain;
    switch (def.type) {
      case 'optional':
      case 'default':
      case 'prefault':
      case 'catch':
      case 'readonly':
      case 'nonoptional':
        current = def.innerType as z.ZodType;
        break;
      case 'pipe': {
        const input = def.in as z.ZodType;
        current = defOf(input)?.type === 'transform' ? (def.out as z.ZodType) : input;
        break;
      }
      case 'lazy':
        current = (def.getter as () => z.ZodType)();
        break;
      default:
        return chain;
    }
    chain.push(current);
  }
  return chain;
}

function compareRequired(json: Record<string, unknown>, expected: string[], mismatch: (what: string) => void): void {
  const declared = Array.isArray(json.required) ? (json.required as unknown[]).map(String) : [];
  const wronglyRequired = declared.filter(key => !expected.includes(key));
  const missingRequired = expected.filter(key => !declared.includes(key));
  if (wronglyRequired.length > 0) {
    mismatch(`listed in required but omission parses: ${wronglyRequired.join(', ')}`);
  }
  if (missingRequired.length > 0) {
    mismatch(`omission fails to parse but not listed in required: ${missingRequired.join(', ')}`);
  }
}

function intersectionParts(schema: z.ZodType): z.ZodType[] {
  const node = unwrap(schema);
  const def = defOf(node);
  if (def?.type !== 'intersection') return [schema];
  return [...intersectionParts(def.left as z.ZodType), ...intersectionParts(def.right as z.ZodType)];
}

type Seen = Map<z.ZodType, Set<unknown>>;

function visit(
  schema: z.ZodType,
  json: unknown,
  path: string,
  issues: string[],
  seen: Seen,
  check: (pair: SchemaPair) => void,
): void {
  const chain = unwrapChain(schema);
  const node = chain[chain.length - 1];
  const def = defOf(node);
  if (!def) return;
  // Recursive schemas: visit each pairing of a Zod node with a JSON node once.
  const pairedWith = seen.get(node) ?? new Set<unknown>();
  if (pairedWith.has(json)) return;
  pairedWith.add(json);
  seen.set(node, pairedWith);
  const mismatch = (what: string) => issues.push(`${path}: ${what}`);
  check({ chain, node, type: def.type, json, mismatch });
  const next = (child: z.ZodType, childJson: unknown, childPath: string) =>
    visit(child, childJson, childPath, issues, seen, check);

  switch (def.type) {
    case 'object': {
      if (!isRecord(json) || !isRecord(json.properties)) {
        mismatch('Zod object has no JSON object with properties');
        return;
      }
      const shape = def.shape as Record<string, z.ZodType>;
      for (const [key, value] of Object.entries(shape)) {
        if (!(key in json.properties)) {
          mismatch(`property ${key} missing from JSON properties`);
          continue;
        }
        next(value, json.properties[key], `${path}.${key}`);
      }
      return;
    }
    case 'nullable': {
      const options = isRecord(json) && Array.isArray(json.anyOf) ? json.anyOf : undefined;
      if (!options || options.length !== 2) {
        mismatch('Zod nullable has no two-branch JSON anyOf');
        return;
      }
      next(def.innerType as z.ZodType, options[0], `${path}|0`);
      return;
    }
    case 'union': {
      const zodOptions = def.options as z.ZodType[];
      const options = isRecord(json) ? (Array.isArray(json.anyOf) ? json.anyOf : json.oneOf) : undefined;
      if (!Array.isArray(options) || options.length !== zodOptions.length) {
        mismatch('Zod union has no JSON anyOf/oneOf with the same number of branches');
        return;
      }
      zodOptions.forEach((option, index) => next(option, options[index], `${path}|${index}`));
      return;
    }
    case 'intersection': {
      const parts = isRecord(json) && Array.isArray(json.allOf) ? json.allOf : undefined;
      // The converter merges a chain such as a.and(b).and(c) into one allOf.
      const flattened = intersectionParts(node);
      const zodParts = parts && parts.length === flattened.length ? flattened : [def.left as z.ZodType, def.right as z.ZodType];
      if (!parts || parts.length !== zodParts.length) {
        mismatch('Zod intersection has no matching JSON allOf');
        return;
      }
      zodParts.forEach((part, index) => next(part, parts[index], `${path}&${index}`));
      return;
    }
    case 'tuple': {
      const items = def.items as z.ZodType[];
      const prefix = isRecord(json) && Array.isArray(json.prefixItems) ? json.prefixItems : undefined;
      if (!prefix || prefix.length !== items.length) {
        mismatch('Zod tuple has no JSON prefixItems with the same length');
        return;
      }
      items.forEach((item, index) => next(item, prefix[index], `${path}[${index}]`));
      if (def.rest) {
        if (!isRecord(json) || !isRecord(json.items)) {
          mismatch('Zod tuple rest has no JSON items schema');
          return;
        }
        next(def.rest as z.ZodType, json.items, `${path}[...]`);
      }
      return;
    }
    case 'array': {
      if (!isRecord(json) || !isRecord(json.items)) {
        mismatch('Zod array has no JSON items schema');
        return;
      }
      next(def.element as z.ZodType, json.items, `${path}[]`);
      return;
    }
    case 'record': {
      if (!isRecord(json) || !isRecord(json.additionalProperties)) {
        mismatch('Zod record has no JSON additionalProperties schema');
        return;
      }
      next(def.valueType as z.ZodType, json.additionalProperties, `${path}{}`);
      return;
    }
    default:
      return;
  }
}
