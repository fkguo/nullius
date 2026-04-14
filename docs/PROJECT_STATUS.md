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
- `standard=70`, `full=77`
- `HEP_ENABLE_ZOTERO=0` → `standard=62`, `full=69`

## What is live today

- **Main generic lifecycle + native TS computation + workflow-plan entrypoint**: `autoresearch` CLI for external project roots and `.autoresearch/` state
- **Canonical generic MCP/operator counterpart**: public `orch_*` control-plane surface documented in `meta/docs/orchestrator-mcp-tools-spec.md` (no separate monolithic root MCP server binary yet)
- **Generic writing/review staging MCP front door**: `orch_run_stage_content` stages post-retrieval writing/review artifacts into an existing run directory; HEP retains `hep_run_stage_content` only as a run-artifact substrate adapter
- **Generic follow-up continuation MCP front door**: `orch_run_progress_followups` advances exactly one computation-generated follow-up task through the generic delegated runtime surface; delegated `idea` and `literature` feedback are now live alongside the writer/reviewer path
- **First higher-conclusion boundary consumer**: `orch_run_request_final_conclusions` / `autoresearch final-conclusions` now consume canonical `computation_result_v1` verification refs and create an A5 approval request only on decisive `pass`; `hold`, `block`, and `unavailable` fail closed without creating pending approval state
- **Single-user compute capability truth**: `orch_run_stage_idea` -> `orch_run_plan_computation` -> `orch_run_execute_manifest` is now the canonical generic lifecycle for staged compute execution; when the staged idea carries an explicit method bundle, planning materializes a provider-backed run-local manifest rather than narrating compute capability through the internal fixture runner
- **Recommended public stateful literature workflow entrypoint**: `autoresearch workflow-plan` (requires an initialized external project root; resolves recipes directly via `@autoresearch/literature-workflows`; persists `.autoresearch/state.json#/plan` and derives `.autoresearch/plan.md`)
- **Native TS run slice**: `autoresearch run` (requires an initialized external project root; runs prepared `computation/manifest.json` natively for `--workflow-id computation`, and also advances dependency-satisfied persisted workflow-plan steps through the same front door)
- **Experimental TS idea runtime surface**: `@autoresearch/idea-engine` + `@autoresearch/idea-mcp` now cover campaign init/status/topup/pause/resume/complete plus bounded search/eval loops on explicit external data roots
- **Current most mature domain MCP front door**: `@autoresearch/hep-mcp` exposed through `packages/hep-mcp/dist/index.js`
- **Current strongest end-to-end workflow family**: `hep_*` Project/Run + evidence + writing + export
- **Direct provider families**: `inspire_*`, `openalex_*`, `arxiv_*`, `hepdata_*`, `pdg_*`, `zotero_*`

## Current truthful workflows

- **Generic lifecycle workflow**: `autoresearch init/status/approve/pause/resume/export`
- **Higher-conclusion boundary workflow**: `autoresearch final-conclusions` / `orch_run_request_final_conclusions` gate A5 on canonical verification truth and reuse the existing approval/read-model surface rather than creating a second publication runtime
- **Generic writing/review staging workflow**: `orch_run_stage_content` stages review/draft artifacts provider-neutrally into an existing run directory; provider-specific staging tools should remain thin adapters only
- **Generic follow-up continuation workflow**: `orch_run_progress_followups` is the canonical bounded consumer for computation-generated feedback and writing/review follow-ups; it progresses one follow-up task per call, consumes only explicit task/handoff authority, and does not invent scheduler or fallback semantics
- **Public stateful literature planning workflow**: `autoresearch workflow-plan` resolves literature recipes directly via `@autoresearch/literature-workflows` into bounded executable steps for an initialized external project root, persists the plan substrate into `.autoresearch/state.json#/plan`, and derives `.autoresearch/plan.md`
- **Native TS run workflow**: `autoresearch run` remains the only execution front door; `--workflow-id computation` executes a prepared `computation/manifest.json`, while persisted workflow-plan steps advance in a bounded loop until completion or a blocking failure is reached
- **Experimental idea campaign workflow**: `idea_campaign_init` -> `idea_search_step` / `idea_eval_run`, with `idea_campaign_topup` / `idea_campaign_pause` / `idea_campaign_resume` / `idea_campaign_complete` on `idea-mcp`
- **Project/Run evidence workflow**: `hep_project_create` -> `hep_run_create` -> evidence build/query -> `hep_render_latex` -> `hep_export_project`
- **Writing/export workflow**: citation mapping, evidence build, verifier-enforced rendering, research pack export, paper scaffold export/import
- **Literature/data workflow**: direct provider search, retrieval, export, and bounded analysis operators
- **Local reference workflow**: Zotero Local API and offline PDG lookups

## Workflow-plan boundary

- `workflow-plan` 现在是公开的 stateful literature front door，且已把稳定的 typed `plan.execution` metadata 写入 `.autoresearch/state.json#/plan`。
- `autoresearch run` 现在是该 seam 的 canonical bounded consumer：它会推进 dependency-satisfied persisted workflow steps，直到完成或遇到 blocking failure，并继续保持唯一 execution front door。
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
