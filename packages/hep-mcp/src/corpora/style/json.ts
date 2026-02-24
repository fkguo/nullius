import { invalidParams } from '@autoresearch/shared';

function normalizeJson(value: unknown): unknown {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (Array.isArray(value)) return value.map(v => normalizeJson(v));
  if (typeof value !== 'object') return value;

  const obj = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(obj).sort()) {
    const v = normalizeJson(obj[key]);
    if (v === undefined) continue;
    out[key] = v;
  }
  return out;
}

export function stableJsonStringify(value: unknown, space?: number): string {
  const normalized = normalizeJson(value);
  return JSON.stringify(normalized, null, space);
}

export function parseJsonObject(text: string, what: string): unknown {
  const raw = text.trim();
  if (!raw) throw invalidParams(`${what} is empty`);
  try {
    return JSON.parse(raw) as unknown;
  } catch (err) {
    throw invalidParams(`${what} is invalid JSON`, {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export function parseJsonl(text: string): unknown[] {
  const lines = text
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean);

  const out: unknown[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    try {
      out.push(JSON.parse(line) as unknown);
    } catch (err) {
      throw invalidParams('Invalid JSONL line', {
        line_number: i + 1,
        error: err instanceof Error ? err.message : String(err),
        preview: line.slice(0, 200),
      });
    }
  }
  return out;
}
