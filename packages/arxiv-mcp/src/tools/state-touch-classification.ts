/**
 * State-touch classification for arxiv-mcp tools.
 *
 * Per the 2026-05-23 P3-C-redesign code audit, all `arxiv_*` tools dispatched
 * through the arxiv-mcp standalone dispatcher are NO_STATE_TOUCH:
 *
 *   - `arxiv_search`           pure HTTP, no fs writes
 *   - `arxiv_get_metadata`     pure HTTP, no fs writes
 *   - `arxiv_paper_source`     writes only to generic `ARXIV_DATA_DIR` cache
 *                              or `/tmp/arxiv-mcp-data` (per
 *                              `src/source/paperContent.ts:48-49,80,100`);
 *                              never project-keyed
 *
 * Therefore the standalone dispatcher always passes `toolIsStateTouching=false`.
 * (When the same tools are re-exposed through hep-mcp under a `project_root`
 * scope, hep-mcp's own classifier applies, not this one.)
 */
export function isStateTouchingArxivMcp(_toolName: string): boolean {
  return false;
}
