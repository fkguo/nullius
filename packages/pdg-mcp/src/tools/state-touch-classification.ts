/**
 * State-touch classification for pdg-mcp tools.
 *
 * Per the 2026-05-23 P3-C-redesign code audit, all pdg-mcp tools dispatched
 * through the pdg-mcp standalone dispatcher are NO_STATE_TOUCH:
 *
 *   - info / find_particle / find_reference / get_reference / get_property
 *     → read-only SQLite queries, no fs writes
 *   - get / get_decays / get_measurements / batch
 *     → write JSON/JSONL artifacts via `writeJsonArtifact` /
 *       `writeJsonlArtifact` to `getArtifactsDir()` = `~/.autoresearch/hep-mcp/pdg/artifacts/`
 *       or `$PDG_DATA_DIR/artifacts` (`src/data/dataDir.ts:10,20-38,55-59`);
 *       generic cache, never project-keyed.
 *
 * IMPORTANT: When these same tools are dispatched via the hep-mcp composite
 * (which wraps them in `withPdgDataDir(resolvedPdgDataDirForCurrentHepRoot())`
 * — see `packages/hep-mcp/src/tools/dispatcher.ts:575`), the PDG cache is
 * rerouted into `<project_root>/artifacts/hep-mcp/pdg/...` and becomes
 * project-keyed. The hep-mcp dispatcher applies its OWN classifier in that
 * context (see `packages/hep-mcp/src/tools/state-touch-classification.ts`),
 * not this one.
 */
export function isStateTouchingPdgMcp(_toolName: string): boolean {
  return false;
}
