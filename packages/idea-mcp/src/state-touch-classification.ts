/**
 * State-touch classification for idea-mcp tools.
 *
 * ALL `idea_*` tools are STATE_TOUCHING: every `idea_campaign_*` tool
 * mutates `<rootDir>/campaigns/<campaign_id>/...` via the engine-store
 * (`packages/idea-engine/src/store/engine-store.ts`), including the
 * read-path tools which still create store root directories on service
 * construction.
 *
 * The `IdeaRpcClient` constructor rejects calls without explicit `rootDir`
 * (`packages/idea-mcp/src/rpc-client.ts`), so there is no
 * NO_STATE_TOUCH path through idea-mcp.
 */
export function isStateTouchingIdeaMcp(_toolName: string): boolean {
  return true;
}
