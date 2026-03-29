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
- `standard=73`, `full=102`
- `HEP_ENABLE_ZOTERO=0` → `standard=65`, `full=94`

## What is live today

- **Main MCP front door**: `@autoresearch/hep-mcp` exposed through `packages/hep-mcp/dist/index.js`
- **Main generic lifecycle entrypoint**: `autoresearch` CLI for external project roots and `.autoresearch/` state
- **Current strongest end-to-end workflow family**: `hep_*` Project/Run + evidence + writing + export
- **Direct provider families**: `inspire_*`, `openalex_*`, `arxiv_*`, `hepdata_*`, `pdg_*`, `zotero_*`
- **Launcher-backed workflow shells**: `hepar literature-gap` and `literature_fetch.py workflow-plan`

## Current truthful workflows

- **Project/Run evidence workflow**: `hep_project_create` -> `hep_run_create` -> evidence build/query -> `hep_render_latex` -> `hep_export_project`
- **Writing/export workflow**: citation mapping, evidence build, verifier-enforced rendering, research pack export, paper scaffold export/import
- **Literature/data workflow**: direct provider search, retrieval, export, and bounded analysis operators
- **Local reference workflow**: Zotero Local API and offline PDG lookups
- **Generic lifecycle workflow**: `autoresearch init/status/approve/pause/resume/export`

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
