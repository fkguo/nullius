/**
 * Query parameter name translation: Zod snake_case → OpenAlex hyphenated API params.
 *
 * OpenAlex API uses hyphenated param names (per-page, group-by) while Zod
 * schemas use underscored names for JS/TS compatibility. This module handles
 * the translation and strips internal-only params before sending to the API.
 */

/**
 * Maps Zod schema field names → OpenAlex API query parameter names.
 * Fields mapped to `null` are internal-only and must not be sent to the API.
 */
const PARAM_NAME_MAP: Record<string, string | null> = {
  per_page: 'per-page',
  group_by: 'group-by',
  // Internal-only params: never sent to OpenAlex
  max_results: null,
  _confirm: null,
  max_size_mb: null,
  out_dir: null,
  refresh: null,
};

/**
 * Build URLSearchParams from Zod-parsed args, translating param names and
 * omitting undefined/null values and internal-only params.
 */
export function buildQueryParams(args: Record<string, unknown>): URLSearchParams {
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(args)) {
    if (value === undefined || value === null) continue;
    // Check if this key is in the map
    if (key in PARAM_NAME_MAP) {
      const apiKey = PARAM_NAME_MAP[key];
      if (apiKey === null) continue; // internal-only, skip
      qs.set(apiKey, String(value));
    } else {
      qs.set(key, String(value));
    }
  }
  return qs;
}

/**
 * Translate a single param name to its API equivalent.
 * Returns the API name, or null if the param should be suppressed.
 */
export function translateParamName(key: string): string | null {
  if (key in PARAM_NAME_MAP) return PARAM_NAME_MAP[key] ?? null;
  return key;
}
