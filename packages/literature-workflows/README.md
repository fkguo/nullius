# @autoresearch/literature-workflows

Checked-in literature-workflow recipes plus the provider/capability resolver consumed by `autoresearch workflow-plan`. Library-only — no CLI or MCP entrypoint of its own.

## Layer

Workflow authority. Holds the high-level workflow meaning that sits **above** provider packs. The `autoresearch` CLI resolves recipes here, persists `.autoresearch/state.json#/plan`, and derives `.autoresearch/plan.md` from the result. See root [README.md](../../README.md) §3 Layer Model.

## What lives here

- Recipe definitions for `literature_landscape`, `literature_gap_analysis`, `derivation_cycle`, `review_cycle`, `research_brainstorm`, etc.
- Provider profiles (which capabilities each provider atom — arxiv, openalex, hepdata, pdg, zotero — fulfills)
- A recipe loader and capability resolver that the orchestrator uses to plan and dispatch steps

## How it is consumed

```bash
autoresearch workflow-plan \
  --recipe literature_landscape \
  --project-root /absolute/path/to/external-project \
  --run-id 20260502T023000Z-m1-landscape-r1
```

The orchestrator imports `@autoresearch/literature-workflows` directly; users do not call this package.

## Build & test

```bash
pnpm -C packages/literature-workflows build
pnpm -C packages/literature-workflows test
```

## See also

- Root [README.md](../../README.md) §1 Surface Policy — stateful literature planning surface
- Root [AGENTS.md](../../AGENTS.md) §Key Checked-in Authority
