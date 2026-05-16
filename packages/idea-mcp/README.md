# @autoresearch/idea-mcp

Narrow stdio MCP surface for the TypeScript idea campaign runtime. Bridges `idea_campaign_init|status|topup|pause|resume|complete`, `idea_search_step`, and `idea_eval_run` over to `@autoresearch/idea-engine` via RPC.

## Layer

Experimental runtime bridge (MCP side). The current idea-engine phase is **closed** — this surface stays explicit and **narrower** than the full engine runtime contract. Not a root front door. See root [README.md](../../README.md) §1 Surface Policy.

## What it does NOT expose

By design, the following stay inside `@autoresearch/idea-engine` and are not MCP tools:

- `rank.compute` and `node.promote` post-search steps
- Negative failure-library reflection cycles
- Direct campaign-state mutation outside the documented tool list

If you need these, run the engine directly.

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
      "args": ["/absolute/path/to/autoresearch-lab/packages/idea-mcp/dist/server.js"]
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

- [`@autoresearch/idea-engine`](../idea-engine/README.md) — full runtime contract
- Root [README.md](../../README.md) §1 Surface Policy
- Root [AGENTS.md](../../AGENTS.md) §Stable Public Invariants — "idea-mcp must not reclaim root workflow authority"
