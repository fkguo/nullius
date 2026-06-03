/**
 * State-touch classification for hepdata-mcp tools.
 *
 * Per the 2026-05-23 P3-C-redesign code audit, all `hepdata_*` tools dispatched
 * through the hepdata-mcp standalone dispatcher are NO_STATE_TOUCH:
 *
 *   - search / get_record / get_table → pure HTTP, no fs writes
 *   - download → writes ZIP to `getArtifactsDir()/submissions/<id>/`
 *     = `~/.hep-mcp/hepdata/artifacts/submissions/` or
 *     `$HEPDATA_DATA_DIR/...` (`src/data/dataDir.ts:8,17-31,44-46`);
 *     generic cache, never project-keyed.
 */
export function isStateTouchingHepdataMcp(_toolName: string): boolean {
  return false;
}
