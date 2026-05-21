/**
 * Recursively sort object keys.
 *
 * Matches Python `json.dumps(..., sort_keys=True)` semantics so JSON
 * artifacts produced from TS callers byte-equal those produced from
 * the legacy Python control plane.
 *
 * Moved to `@autoresearch/shared/utils` (P1) from
 * `packages/orchestrator/src/util.ts` so non-orchestrator packages can
 * use it without a dependency hop. The orchestrator util.ts re-exports
 * this so existing imports remain valid.
 */
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
