# Project Status Report (vNext baseline)

**Date**: 2026-01-18  
**Branch**: `main`  
**Baseline commit**: `1496734`  
**Status**: Production Ready (local-first, evidence-first)

---

## QA snapshot

- `pnpm -r build` ✅
- `pnpm -r test` ✅
- `pnpm -r lint` ✅

**Tool counts (after build)**  
SSOT:

```bash
node --input-type=module -e "import('./packages/hep-mcp/dist/tools/index.js').then(({getTools})=>console.log('standard',getTools('standard').length,'full',getTools('full').length))"
```

Current (after build):
- `standard=73`, `full=101`
- `HEP_ENABLE_ZOTERO=0` → `standard=65`, `full=93`

Workspace vitest summary:
- `packages/shared`: 15 passed
- `packages/zotero-mcp`: 18 passed
- `packages/pdg-mcp`: 41 passed
- `packages/hep-mcp`: 553 passed, 2 skipped (eval/live smoke)

---

## What’s included

- **vNext Project/Run + `hep://` resources**: artifacts-first, reproducible workflows (`hep_*`)
- **INSPIRE workflows**: search/export, launcher-backed literature front door (`hepar literature-gap`, `python3 skills/research-team/scripts/bin/literature_fetch.py workflow-plan`), bounded atomic operators (`inspire_topic_analysis`, `inspire_network_analysis`, `inspire_find_connections`, `inspire_trace_original_source`, `inspire_grade_evidence`, `inspire_detect_measurement_conflicts`, `inspire_critical_analysis`, `inspire_classify_reviews`, `inspire_theoretical_conflicts`), run-scoped LaTeX parsing (`inspire_parse_latex`)
- **Bibliography usability audit (Phase 4.1)**: `inspire_validate_bibliography` is manual-first + non-blocking warnings; optional INSPIRE cross-check
- **Zotero Local API**: local-only integration (`zotero_local` + related tools; optional; gated by `HEP_ENABLE_ZOTERO`)
- **Zotero read bridge (Phase 4.5)**: `zotero_find_items` + `zotero_search_items` share internal bridge execution while preserving semantics
- **PDG offline DB**: local-only tools/resources (`pdg_*`, requires `PDG_DB_PATH`)
- **PDG version transparency (Phase 4.7)**: use `pdg_info` / `pdg://info` to inspect local DB edition metadata without freshness judgments
- **Skill↔MCP bridge contract (Phase 4.10, slice 1)**: run-scoped responses include `job` envelope (`job_id`, `status_uri`, `polling`) for consistent long-task polling semantics
- **Telemetry (Phase 4.9)**: opt-in tool usage counters (disabled by default) exported via `hep_health.telemetry` for scheduling diagnostics

---

## Canonical writing workflows

### Draft Path (external draft → MCP render/verify/export)

- `hep_project_create` → `hep_run_create`
- `hep_render_latex` (hard verifier)
- Draft Path: `hep_render_latex` → `hep_export_project`
- Publication round-trip: `hep_export_paper_scaffold` → *(external editing / research-writer)* → `hep_import_paper_bundle`

See: `docs/WRITING_RECIPE_DRAFT_PATH.md`

See: `docs/WRITING_RECIPE_CLIENT_PATH.md`
