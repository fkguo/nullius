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
- **Recommended launcher-backed literature workflow entrypoint**: `autoresearch workflow-plan` (requires an initialized external project root; resolves recipes directly via `@autoresearch/literature-workflows`; persists `.autoresearch/state.json#/plan` and derives `.autoresearch/plan.md`; any checked-in Python consumers remain internal regression proof only)
- **Native TS computation run slice**: `autoresearch run --workflow-id computation` (requires an initialized external project root plus a prepared `computation/manifest.json`; still intentionally bounded to computation only)
- **Current most mature domain MCP front door**: `@autoresearch/hep-mcp` exposed through `packages/hep-mcp/dist/index.js`
- **Current strongest end-to-end workflow family**: `hep_*` Project/Run + evidence + writing + export
- **Direct provider families**: `inspire_*`, `openalex_*`, `arxiv_*`, `hepdata_*`, `pdg_*`, `zotero_*`

## Current truthful workflows

- **Generic lifecycle workflow**: `autoresearch init/status/approve/pause/resume/export`
- **Launcher-backed literature workflow**: `autoresearch workflow-plan` resolves literature recipes directly via `@autoresearch/literature-workflows` into bounded executable steps for an initialized external project root, persists the plan substrate into `.autoresearch/state.json#/plan`, derives `.autoresearch/plan.md`, and keeps any checked-in Python consumers as internal regression proof only
- **Native TS computation workflow**: `autoresearch run --workflow-id computation` executes a prepared `computation/manifest.json` on an initialized external project root; gate handling stays on `autoresearch status/approve`
- **Project/Run evidence workflow**: `hep_project_create` -> `hep_run_create` -> evidence build/query -> `hep_render_latex` -> `hep_export_project`
- **Writing/export workflow**: citation mapping, evidence build, verifier-enforced rendering, research pack export, paper scaffold export/import
- **Literature/data workflow**: direct provider search, retrieval, export, and bounded analysis operators
- **Local reference workflow**: Zotero Local API and offline PDG lookups

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
