# @nullius/idea-engine

TypeScript idea-campaign runtime and contract authority. Library-only — no CLI or MCP surface here (a thin stdin/stdout bridge, `bin/idea-rpc.mjs`, exposes the JSON-RPC service to local tooling). Owns the full runtime contract for `idea_campaign_*` lifecycle, node reads, node posterior/lifecycle updates (`node.set_posterior`, `node.set_lifecycle`), posterior-based `rank.compute`, and `node.promote`.

## Layer

Experimental runtime bridge (engine side) for the **probability-managed idea portfolio** — restarted in 0.5.0 from island-evolution search + heuristic scoring. The idea-engine search/eval runtime is **archived**; contracts + store are retained, and scoring consumes an external belief-graph posterior (pinned tool, current pin gaia-lang==0.5.0a4). Being restarted into a portfolio engine does not make it a front door: it stays opt-in — not a default capability-expansion lane and not a root front door. See root [README.md](../../README.md) §1 Surface Policy and §3 Layer Model.

## Portfolio model

- Idea significance is decomposed into source-grounded sub-criteria whose posterior is computed by an external belief-graph tool and written back via `node.set_posterior` (value, evidence count, optional package reference).
- Nodes carry a lifecycle state (`active` / `waiting_activation` / `archived`); `waiting_activation` requires an explicit activation condition.
- `rank.compute` orders active nodes by posterior (ties by evidence count, then stable order) and reports excluded nodes explicitly in `skipped_nodes`.
- `node.promote` gates on idea-card completeness, grounding, active lifecycle, and a non-null posterior — no numeric posterior threshold; review audits anchors, not scores.
- Investment allocation is a decision-layer concern (`allocation_decision_v1` contract); the engine only stores beliefs and orderings.

## Boundary with `@nullius/idea-mcp`

`idea-mcp` is the narrow stdio surface that delegates to this package via RPC. The MCP surface is intentionally narrower than the full runtime contract — node posterior/lifecycle updates, `rank.compute`, and `node.promote` stay inside this engine, not exposed as MCP tools.

## Build & test

```bash
pnpm -C packages/idea-engine build
pnpm -C packages/idea-engine test
```

## See also

- Root [README.md](../../README.md) §1 — idea-mcp / idea-engine boundary
- [docs/ARCHITECTURE.md](../../docs/ARCHITECTURE.md) §1 layer "Experimental runtime bridge"
- Root [AGENTS.md](../../AGENTS.md) §Key Checked-in Authority
