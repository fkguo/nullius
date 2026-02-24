// Shared utility functions for @autoresearch/orchestrator.

/** Recursively sort object keys to match Python json.dumps(sort_keys=True). */
export function sortKeysRecursive(obj: unknown): unknown {
  if (Array.isArray(obj)) return obj.map(sortKeysRecursive);
  if (obj !== null && typeof obj === 'object') {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(obj as Record<string, unknown>).sort()) {
      sorted[key] = sortKeysRecursive((obj as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return obj;
}

/** UTC ISO timestamp with Z suffix, no milliseconds (matching Python utc_now_iso). */
export function utcNowIso(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}
