/**
 * State-touch classification for idea-mcp tools.
 *
 * Per the 2026-05-23 P3-C-redesign code audit, ALL `idea_*` tools are
 * STATE_TOUCHING:
 *
 *   - All `idea_campaign_*` tools mutate `<rootDir>/campaigns/<campaign_id>/...`
 *     via the engine-store (`packages/idea-engine/src/store/engine-store.ts`).
 *   - `idea_search_step` mutates `<rootDir>/campaigns/<campaign_id>/nodes_log.jsonl`
 *     + `nodes_latest.json`.
 *   - `idea_eval_run` mutates campaign artifacts under
 *     `<rootDir>/campaigns/<campaign_id>/artifacts/`.
 *
 * The `IdeaRpcClient` constructor rejects calls without explicit `rootDir`
 * (`packages/idea-mcp/src/rpc-client.ts:25-28`), so there is no
 * NO_STATE_TOUCH path through idea-mcp.
 */
export function isStateTouchingIdeaMcp(_toolName: string): boolean {
  return true;
}
