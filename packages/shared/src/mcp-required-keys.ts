import { z } from 'zod';

/**
 * Check the `required` lists of a published MCP `inputSchema` against what
 * the Zod schema it was derived from actually accepts.
 *
 * For every object in the Zod schema (nested objects included, through
 * optional/default/nullable wrappers, arrays, records, unions and
 * intersections), a key must appear in the matching JSON object's `required`
 * list exactly when an object holding only that key rejects its omission:
 * `z.object({ [key]: shape[key] }).safeParse({})` fails. The reference is the
 * parser itself, not the converter, so a converter that marks an omissible key
 * required (or the reverse) is caught. Object-level refinements that tie keys
 * together are outside this per-key rule.
 *
 * Returns one line per disagreement, and one line per place where the JSON
 * structure could not be matched to the Zod structure; an empty list means the
 * schema passes.
 */
export function findRequiredKeyMismatches(schema: z.ZodType, inputSchema: unknown): string[] {
  const issues: string[] = [];
  visit(schema, inputSchema, '$', issues, new Map());
  return issues;
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
  let current = schema;
  for (let depth = 0; depth < 64; depth += 1) {
    const def = defOf(current);
    if (!def) return current;
    switch (def.type) {
      case 'optional':
      case 'default':
      case 'prefault':
      case 'catch':
      case 'readonly':
      case 'nonoptional':
        current = def.innerType as z.ZodType;
        continue;
      case 'pipe': {
        const input = def.in as z.ZodType;
        current = defOf(input)?.type === 'transform' ? (def.out as z.ZodType) : input;
        continue;
      }
      case 'lazy':
        current = (def.getter as () => z.ZodType)();
        continue;
      default:
        return current;
    }
  }
  return current;
}

type Seen = Map<z.ZodType, Set<unknown>>;

function visit(schema: z.ZodType, json: unknown, path: string, issues: string[], seen: Seen): void {
  const node = unwrap(schema);
  const def = defOf(node);
  if (!def) return;
  // Recursive schemas: visit each pairing of a Zod node with a JSON node once.
  const pairedWith = seen.get(node) ?? new Set<unknown>();
  if (pairedWith.has(json)) return;
  pairedWith.add(json);
  seen.set(node, pairedWith);
  const mismatch = (what: string) => issues.push(`${path}: ${what}`);

  switch (def.type) {
    case 'object': {
      if (!isRecord(json) || !isRecord(json.properties)) {
        mismatch('Zod object has no JSON object with properties');
        return;
      }
      const shape = def.shape as Record<string, z.ZodType>;
      const declared = Array.isArray(json.required) ? (json.required as unknown[]).map(String) : [];
      const expected = Object.keys(shape).filter(key => !z.object({ [key]: shape[key] }).safeParse({}).success);
      const wronglyRequired = declared.filter(key => !expected.includes(key));
      const missingRequired = expected.filter(key => !declared.includes(key));
      if (wronglyRequired.length > 0) {
        mismatch(`listed in required but omission parses: ${wronglyRequired.join(', ')}`);
      }
      if (missingRequired.length > 0) {
        mismatch(`omission fails to parse but not listed in required: ${missingRequired.join(', ')}`);
      }
      for (const [key, value] of Object.entries(shape)) {
        if (!(key in json.properties)) {
          mismatch(`property ${key} missing from JSON properties`);
          continue;
        }
        visit(value, json.properties[key], `${path}.${key}`, issues, seen);
      }
      return;
    }
    case 'nullable': {
      const options = isRecord(json) && Array.isArray(json.anyOf) ? json.anyOf : undefined;
      if (!options || options.length !== 2) {
        mismatch('Zod nullable has no two-branch JSON anyOf');
        return;
      }
      visit(def.innerType as z.ZodType, options[0], `${path}|0`, issues, seen);
      return;
    }
    case 'union': {
      const zodOptions = def.options as z.ZodType[];
      const options = isRecord(json) ? (Array.isArray(json.anyOf) ? json.anyOf : json.oneOf) : undefined;
      if (!Array.isArray(options) || options.length !== zodOptions.length) {
        mismatch('Zod union has no JSON anyOf/oneOf with the same number of branches');
        return;
      }
      zodOptions.forEach((option, index) => visit(option, options[index], `${path}|${index}`, issues, seen));
      return;
    }
    case 'intersection': {
      const parts = isRecord(json) && Array.isArray(json.allOf) ? json.allOf : undefined;
      if (!parts || parts.length !== 2) {
        mismatch('Zod intersection has no two-part JSON allOf');
        return;
      }
      visit(def.left as z.ZodType, parts[0], `${path}&0`, issues, seen);
      visit(def.right as z.ZodType, parts[1], `${path}&1`, issues, seen);
      return;
    }
    case 'array': {
      if (!isRecord(json) || !isRecord(json.items)) {
        mismatch('Zod array has no JSON items schema');
        return;
      }
      visit(def.element as z.ZodType, json.items, `${path}[]`, issues, seen);
      return;
    }
    case 'record': {
      if (!isRecord(json) || !isRecord(json.additionalProperties)) {
        mismatch('Zod record has no JSON additionalProperties schema');
        return;
      }
      visit(def.valueType as z.ZodType, json.additionalProperties, `${path}{}`, issues, seen);
      return;
    }
    default:
      return;
  }
}
