# @autoresearch/idea-engine

TypeScript idea-campaign runtime and contract authority. Library-only — no CLI or MCP surface here. Owns the full runtime contract for `idea_campaign_*`, `idea_search_step`, `idea_eval_run`, post-search `rank.compute` / `node.promote`, and bounded negative failure-library reflection.

## Layer

Experimental runtime bridge (engine side). The current idea-engine phase is **closed** — this is not a default capability-expansion lane and not a root front door. See root [README.md](../../README.md) §1 Surface Policy and §3 Layer Model.

## Boundary with `@autoresearch/idea-mcp`

`idea-mcp` is the narrow stdio surface that delegates to this package via RPC. The MCP surface is intentionally narrower than the full runtime contract — `rank.compute` and `node.promote` stay inside this engine, not exposed as MCP tools.

## Build & test

```bash
pnpm -C packages/idea-engine build
pnpm -C packages/idea-engine test
```

## See also

- Root [README.md](../../README.md) §1 — idea-mcp / idea-engine boundary
- [docs/ARCHITECTURE.md](../../docs/ARCHITECTURE.md) §1 layer "Experimental runtime bridge"
- Root [AGENTS.md](../../AGENTS.md) §Key Checked-in Authority
