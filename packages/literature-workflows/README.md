# @nullius/literature-workflows

Checked-in literature-workflow recipes plus the provider/capability resolver consumed by `nullius workflow-plan`. Library-only — no CLI or MCP entrypoint of its own.

## Layer

Workflow authority. Holds the high-level workflow meaning that sits **above** provider packs. The `nullius` CLI resolves recipes here, persists `.nullius/state.json#/plan`, and derives `.nullius/plan.md` from the result. See root [README.md](../../README.md) §3 Layer Model.

## What lives here

- Recipe definitions for `literature_landscape`, `literature_gap_analysis`, `derivation_cycle`, `review_cycle`, `research_brainstorm`, etc.
- Provider profiles (which capabilities each provider atom — arxiv, openalex, hepdata, pdg, zotero — fulfills)
- A recipe loader and capability resolver that the orchestrator uses to plan and dispatch steps

## How it is consumed

```bash
nullius workflow-plan \
  --recipe literature_landscape \
  --project-root /absolute/path/to/external-project \
  --run-id 20260502T023000Z-m1-landscape-r1
```

The orchestrator imports `@nullius/literature-workflows` directly; users do not call this package.

Literature recipes carry a fail-closed saturation handoff. In addition to
provider pagination/cursor accounting and bounded citation expansion, the handoff
requires a disposition record for every candidate, direct-bibliography
reconciliation for every selected core source, stable identity resolution where
possible with unresolved entries retained as coverage debt, and a method-family
audit grounded in source-local and cited method descriptions. A workflow cannot
report `saturated` while any of those ledgers remains open; bounded stops remain
explicit `coverage_incomplete` debt.

## Build & test

```bash
pnpm -C packages/literature-workflows build
pnpm -C packages/literature-workflows test
```

## See also

- Root [README.md](../../README.md) §1 Surface Policy — stateful literature planning surface
- Root [AGENTS.md](../../AGENTS.md) §Key Checked-in Authority
