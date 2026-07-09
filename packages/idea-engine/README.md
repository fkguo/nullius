# @nullius/idea-engine

TypeScript idea-campaign runtime and contract authority. Library-only — no CLI or MCP surface here (a thin stdin/stdout bridge, `bin/idea-rpc.mjs`, exposes the JSON-RPC service to local tooling). Owns the full runtime contract for `idea_campaign_*` lifecycle, node reads, node posterior/lifecycle updates (`node.set_posterior`, `node.set_lifecycle`), generation-pack import (`node.import_generated`), posterior-based `rank.compute`, and `node.promote`.

## Layer

Experimental runtime bridge (engine side) for the **probability-managed idea portfolio** — restarted in 0.5.0 from island-evolution search + heuristic scoring. The idea-engine search/eval runtime is **archived**; contracts + store are retained, and scoring consumes an external belief-graph posterior (pinned tool, current pin gaia-lang==0.5.0a4). Being restarted into a portfolio engine does not make it a front door: it stays opt-in — not a default capability-expansion lane and not a root front door. See root [README.md](../../README.md) §1 Surface Policy and §3 Layer Model.

## Portfolio model

- Idea significance is decomposed into source-grounded sub-criteria whose posterior is computed by an external belief-graph tool and written back via `node.set_posterior` (value, evidence count, optional package reference).
- Nodes move through an enforced lifecycle state machine: `candidate` (born here; no posterior yet) → `admission_review` (admission declared) → `admitted` (current store-backed posterior; the only rankable/promotable state) ↔ `needs_refresh` (posterior held that is not current guidance), with `admission_blocked` (missing required evidence, recorded as an activation condition), `waiting_activation` (parked on an external condition), and `archived` (requires a reason; revival is re-intake as `candidate`/`needs_refresh`, never a shortcut back to `admitted`). `node.set_lifecycle` rejects transitions outside the table with the allowed next states, and checks entry preconditions on stored data (posterior presence/status, close-prior coverage).
- `node.set_posterior` is legal only in `admission_review` / `admitted` / `needs_refresh`, refuses a `current`-labeled posterior that its coverage cannot support, and derives the lifecycle itself after the write (status `current` → `admitted`, otherwise `needs_refresh`) — lifecycle and posterior cannot drift.
- `rank.compute` orders admitted nodes by posterior (ties by evidence count, then stable order), reports every other node explicitly in `skipped_nodes` with its lifecycle state as the reason, and re-checks admitted nodes' stored data as defense in depth.
- `node.promote` gates on idea-card completeness, grounding, the admitted lifecycle state, and a non-null posterior — no numeric posterior threshold; review audits anchors, not scores.
- Derived (non-seed) nodes enter ONLY through `node.import_generated`: one `generation_pack_v1` per generation burst (candidates with full provenance plus the operator's own rejected candidates), validated against a committed operator-family arity table and retrieval-receipt rules, idea cards assembled deterministically engine-side (same explain-then-formalize trace as seed import), the pack archived verbatim as a campaign artifact, and the nodes budget enforced batch-atomically. Imported nodes are born as `candidate` with `posterior: null` — generation never scores.
- Investment allocation is a decision-layer concern (`allocation_decision_v1` contract); the engine only stores beliefs and orderings.

### Migrating stores written before the lifecycle state machine

There is no validator-side default any more: `lifecycle_state` is required and `active` is not a state. For a store written by an earlier engine, rewrite `nodes_latest.json` once (with a backup; this one-time migration is the sanctioned exception to "never edit the store by hand"): map `active`/absent by data — no posterior → `candidate`; `posterior.status = current` with scoring-eligible coverage (survey + close-prior matrix refs, saturated or incomplete with the explicit exploratory waiver) → `admitted`; any other posterior → `needs_refresh`; `waiting_activation`/`archived` unchanged. Then apply judgment states (`admission_review`, `admission_blocked`) per node through `node.set_lifecycle`. Complete or flush any prepared-but-unfinished operations before migrating; pre-migration idempotency records replay their original pre-migration summaries (marked `is_replay: true`), which is harmless history.

## Boundary with `@nullius/idea-mcp`

`idea-mcp` is the narrow stdio surface that delegates to this package via RPC. The MCP surface is intentionally narrower than the full runtime contract — node posterior/lifecycle updates, `node.import_generated`, `rank.compute`, and `node.promote` stay inside this engine, not exposed as MCP tools.

## Build & test

```bash
pnpm -C packages/idea-engine build
pnpm -C packages/idea-engine test
```

## See also

- Root [README.md](../../README.md) §1 — idea-mcp / idea-engine boundary
- [docs/ARCHITECTURE.md](../../docs/ARCHITECTURE.md) §1 layer "Experimental runtime bridge"
- Root [AGENTS.md](../../AGENTS.md) §Key Checked-in Authority
