/**
 * State-touch classification for zotero-mcp tools.
 *
 * Per the 2026-05-23 P3-C-redesign code audit, all `zotero_*` tools dispatched
 * through the zotero-mcp standalone dispatcher are NO_STATE_TOUCH:
 *
 *   - zotero_local (dispatch to Zotero HTTP API: list_collections,
 *     get_item, ...) → no fs writes
 *   - zotero_find_items / zotero_search_items / zotero_export_items /
 *     zotero_get_selected_collection → Zotero HTTP API only, no fs writes
 *   - zotero_add → preview only; stores confirm_token in process-memory map
 *     (`src/zotero/confirm.ts`); no project-keyed fs writes
 *   - zotero_confirm → consumes in-process token + calls Zotero HTTP API;
 *     no project-keyed fs writes
 */
export function isStateTouchingZoteroMcp(_toolName: string): boolean {
  return false;
}
