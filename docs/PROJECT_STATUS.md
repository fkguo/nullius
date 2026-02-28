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
node --input-type=module -e "import('./packages/hep-research-mcp/dist/tools/index.js').then(({getTools})=>console.log('standard',getTools('standard').length,'full',getTools('full').length))"
```

Current (after build):
- `standard=79`, `full=102`
- `HEP_ENABLE_ZOTERO=0` → `standard=71`, `full=94`

Workspace vitest summary:
- `packages/shared`: 15 passed
- `packages/zotero-mcp`: 18 passed
- `packages/pdg-mcp`: 41 passed
- `packages/hep-research-mcp`: 553 passed, 2 skipped (eval/live smoke)

---

## What’s included

- **vNext Project/Run + `hep://` resources**: artifacts-first, reproducible workflows (`hep_*`)
- **INSPIRE workflows**: search/export, navigator（discover/field_survey/topic_analysis/network/experts/connections/trace_source/analyze）, run-scoped LaTeX parsing（`inspire_parse_latex`）, deep research (`inspire_*`)
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
- Export: `hep_export_project` (research pack)
- Publication round-trip: `hep_export_paper_scaffold` (scaffold) → *(external editing / research-writer)* → `hep_import_paper_bundle` (paper_bundle.zip + paper_final.pdf)

See: `docs/WRITING_RECIPE_DRAFT_PATH.md`

### Client Path (host LLM writes candidates → MCP judge/verify → integrate/export)

- Run setup/orchestration (recommended): `inspire_deep_research(mode=write, run_id=..., llm_mode=client)` and follow `next_actions`
- Section submission (canonical): `hep_run_writing_submit_section_candidates_v1` → `hep_run_writing_submit_section_judge_decision_v1`
- Integration: `hep_run_writing_integrate_sections_v1` → `writing_integrated.tex` + `writing_integrate_diagnostics.json`
- Export:
  - `hep_export_project` (typically using `writing_integrated.tex` as `rendered_latex_artifact_name`)
  - `hep_export_paper_scaffold` (writes `paper_manifest.json` + `paper_scaffold.zip`)
  - `hep_import_paper_bundle` (imports finalized `paper/` back into run artifacts)

See: `docs/WRITING_RECIPE_CLIENT_PATH.md`
