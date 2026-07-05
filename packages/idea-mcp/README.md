# @nullius/idea-mcp

Narrow stdio MCP surface for the TypeScript idea campaign runtime. Bridges `idea_campaign_init|status|topup|pause|resume|complete` over to `@nullius/idea-engine` via RPC.

## Layer

Experimental runtime bridge (MCP side). The idea-engine search/eval runtime is **archived**; contracts + store are retained, and scoring consumes an external belief-graph posterior (pinned tool, current pin gaia-lang==0.5.0a4). This surface stays explicit and **narrower** than the full engine runtime contract. Not a root front door. See root [README.md](../../README.md) §1 Surface Policy.

## What it does NOT expose

By design, the following stay inside `@nullius/idea-engine` and are not MCP tools:

- `node.set_posterior` and `node.set_lifecycle` belief/lifecycle updates
- Posterior-based `rank.compute` and `node.promote`
- Direct campaign-state mutation outside the documented tool list

If you need these, use the engine directly (library import or `packages/idea-engine/bin/idea-rpc.mjs`).

## Run

```bash
pnpm -r build
node packages/idea-mcp/dist/server.js
```

Wire into an MCP client:

```json
{
  "mcpServers": {
    "idea-mcp": {
      "command": "node",
      "args": ["/absolute/path/to/nullius/packages/idea-mcp/dist/server.js"]
    }
  }
}
```

Legacy provider-local backend envs are rejected on startup — TS `idea-engine` is the sole authority.

## Build & test

```bash
pnpm -C packages/idea-mcp build
pnpm -C packages/idea-mcp test
```

## See also

- [`@nullius/idea-engine`](../idea-engine/README.md) — full runtime contract
- Root [README.md](../../README.md) §1 Surface Policy
- Root [AGENTS.md](../../AGENTS.md) §Stable Public Invariants — "idea-mcp must not reclaim root workflow authority"
