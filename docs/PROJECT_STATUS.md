# Project Status Report (front-door rebaseline)

**Date**: 2026-03-29
**Status**: Active local-first, evidence-first monorepo
**Root framing**: Domain-neutral substrate + control plane; HEP is the current most mature provider family, not the root identity

---

## QA snapshot

- `pnpm -r build` ✅
- `pnpm -r test` ✅
- `pnpm -r lint` ✅
- `pnpm --filter @autoresearch/hep-mcp docs:tool-counts:check` ✅
- `standard=72`, `full=101`
- `HEP_ENABLE_ZOTERO=0` → `standard=64`, `full=93`

## What is live today

- **Main generic lifecycle + native TS computation + workflow-plan entrypoint**: `autoresearch` CLI for external project roots and `.autoresearch/` state
- **Canonical generic MCP/operator counterpart**: public `orch_*` control-plane surface documented in `meta/docs/orchestrator-mcp-tools-spec.md` (no separate monolithic root MCP server binary yet)
- **Recommended public stateful literature workflow entrypoint**: `autoresearch workflow-plan` (requires an initialized external project root; resolves recipes directly via `@autoresearch/literature-workflows`; persists `.autoresearch/state.json#/plan` and derives `.autoresearch/plan.md`)
- **Native TS run slice**: `autoresearch run` (requires an initialized external project root; runs prepared `computation/manifest.json` natively for `--workflow-id computation`, and also consumes one dependency-satisfied persisted workflow-plan step through the same front door)
- **Experimental TS idea runtime surface**: `@autoresearch/idea-engine` + `@autoresearch/idea-mcp` now cover campaign init/status/topup/pause/resume/complete plus bounded search/eval loops on explicit external data roots
- **Current most mature domain MCP front door**: `@autoresearch/hep-mcp` exposed through `packages/hep-mcp/dist/index.js`
- **Current strongest end-to-end workflow family**: `hep_*` Project/Run + evidence + writing + export
- **Direct provider families**: `inspire_*`, `openalex_*`, `arxiv_*`, `hepdata_*`, `pdg_*`, `zotero_*`

## Current truthful workflows

- **Generic lifecycle workflow**: `autoresearch init/status/approve/pause/resume/export`
- **Public stateful literature planning workflow**: `autoresearch workflow-plan` resolves literature recipes directly via `@autoresearch/literature-workflows` into bounded executable steps for an initialized external project root, persists the plan substrate into `.autoresearch/state.json#/plan`, and derives `.autoresearch/plan.md`
- **Native TS run workflow**: `autoresearch run` remains the only execution front door; `--workflow-id computation` executes a prepared `computation/manifest.json`, while persisted workflow-plan steps execute one dependency-satisfied step at a time
- **Experimental idea campaign workflow**: `idea_campaign_init` -> `idea_search_step` / `idea_eval_run`, with `idea_campaign_topup` / `idea_campaign_pause` / `idea_campaign_resume` / `idea_campaign_complete` on `idea-mcp`
- **Project/Run evidence workflow**: `hep_project_create` -> `hep_run_create` -> evidence build/query -> `hep_render_latex` -> `hep_export_project`
- **Writing/export workflow**: citation mapping, evidence build, verifier-enforced rendering, research pack export, paper scaffold export/import
- **Literature/data workflow**: direct provider search, retrieval, export, and bounded analysis operators
- **Local reference workflow**: Zotero Local API and offline PDG lookups

## Workflow-plan boundary

- `workflow-plan` 现在是公开的 stateful literature front door，且已把稳定的 typed `plan.execution` metadata 写入 `.autoresearch/state.json#/plan`。
- `autoresearch run` 现在是该 seam 的 canonical minimal consumer：它会执行一个 dependency-satisfied persisted workflow step，并继续保持唯一 execution front door。
- 当前 slice 仍未提供 canonical closed-loop literature execution runtime；这里还没有 full scheduler、多步自主编排或 end-to-end closed loop。

## State and resource truth

- `HEP_DATA_DIR` defaults to `~/.hep-mcp`
- HEP project/run artifacts live under `projects/<project_id>/...` and `runs/<run_id>/...`
- HEP resources surface through `hep://projects`, `hep://runs`, and resource templates for papers, manifests, and artifacts
- Generic lifecycle state lives in external project roots under `.autoresearch/`
- Approval packets are materialized under `artifacts/runs/<run_id>/approvals/<approval_id>/approval_packet_v1.json`

## Canonical docs

- [`README.md`](../README.md)
- [`docs/ARCHITECTURE.md`](./ARCHITECTURE.md)
- [`docs/TESTING_GUIDE.md`](./TESTING_GUIDE.md)
- [`docs/TOOL_CATEGORIES.md`](./TOOL_CATEGORIES.md)
- [`docs/URI_REGISTRY.md`](./URI_REGISTRY.md)
