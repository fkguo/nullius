/**
 * stdout hygiene:
 * MCP uses stdout for JSON-RPC. Any logs to stdout will corrupt the protocol.
 * Route console log-like methods to stderr to keep stdout pure.
 */

function routeToStderr(...args: unknown[]): void {
  // eslint-disable-next-line no-console
  console.error(...args);
}

// Patch once (idempotent enough for our use).
// eslint-disable-next-line no-console
if (console.log !== routeToStderr) console.log = routeToStderr;
// eslint-disable-next-line no-console
if (console.debug !== routeToStderr) console.debug = routeToStderr;
// eslint-disable-next-line no-console
if (console.info !== routeToStderr) console.info = routeToStderr;
