/**
 * State-touch classification for openalex-mcp tools.
 *
 * Per the 2026-05-23 P3-C-redesign code audit, all `openalex_*` tools dispatched
 * through the openalex-mcp standalone dispatcher are NO_STATE_TOUCH:
 *
 *   - search / semantic_search / get / filter / group / references /
 *     citations / batch / autocomplete / content / rate_limit
 *
 * Bulk JSONL writes (from search/filter/citations in `paginatedFetch` mode)
 * go to `getDataDir() + '/results/<shortid>.jsonl'` (default
 * `~/.nullius/openalex/`), and `openalex_content` writes to
 * `getDataDir()/content/`. Both are generic cache locations
 * (`src/api/client.ts:35-41,159-162`, `src/api/contentDownload.ts:68-138`),
 * never project-keyed.
 *
 * Therefore the standalone dispatcher always passes `toolIsStateTouching=false`.
 */
export function isStateTouchingOpenalexMcp(_toolName: string): boolean {
  return false;
}
