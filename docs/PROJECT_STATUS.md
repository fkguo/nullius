# Project Status Report (front-door rebaseline)

**Date**: 2026-05-13
**Status**: Active local-first, evidence-first monorepo
**Root framing**: Domain-neutral substrate + control plane; HEP is the current most mature provider family, not the root identity

---

## QA snapshot

- Closeout baseline: `main` at `fc31bdbd`
- Latest confirmed idea-engine CI: `25000327821` success
- `pnpm -r build` ✅
- `pnpm -r test` ✅
- `pnpm -r lint` ✅
- `pnpm --filter @autoresearch/hep-mcp docs:tool-counts:check` ✅
- `standard=75`, `full=82`
- `HEP_ENABLE_ZOTERO=0` → `standard=66`, `full=73`

## What is live today

- **Main generic lifecycle + native TS computation + workflow-plan entrypoint**: `autoresearch` CLI for external project roots and `.autoresearch/` state
- **Canonical generic MCP/operator counterpart**: public `orch_*` control-plane surface documented in `meta/docs/orchestrator-mcp-tools-spec.md` (no separate monolithic root MCP server binary yet)
- **Generic control plane**: `autoresearch` / `orch_*` are the generic stateful control plane for run state, bounded execution, verification, proposal lifecycle, and read-model visibility
- **Agent project harness skill**: `research-harness` is the thin Codex / Claude Code / OpenCode entry skill for external project continuation. It restores `.autoresearch/` plus durable project files, routes lifecycle work to `autoresearch`, milestone execution to `research-team`, Markdown note cleanup to `markdown-hygiene`, HEP evidence work to `hep-mcp`, and folds stable results back into `research_contract.md`, `research_plan.md#Current Status`, and `artifacts/runs/<run_id>/`.
- **Runtime project handshake**: `autoresearch init` writes `.autoresearch/HARNESS`, a machine-readable signal that requires agents to obtain an `autoresearch status --json` receipt before new work, milestone execution, closeout, or handoff.
- **Generic writing/review staging MCP front door**: `orch_run_stage_content` stages post-retrieval writing/review artifacts into an existing run directory; HEP retains `hep_run_stage_content` only as a run-artifact substrate adapter
- **Generic follow-up continuation MCP front door**: `orch_run_progress_followups` advances exactly one computation-generated follow-up task through the generic delegated runtime surface; delegated `idea` and `literature` feedback are now live alongside the writer/reviewer path
- **Runtime decisive verification front door**: `orch_run_record_verification` / `autoresearch verify` now materialize `verification_check_run_v1` plus refreshed verdict/coverage/check-run refs for an existing computation run, making the A5 `pass` path runtime-reachable without REP
- **First higher-conclusion boundary consumer**: `orch_run_request_final_conclusions` / `autoresearch final-conclusions` now consume canonical `computation_result_v1` verification refs and create an A5 approval request only on decisive `pass`; approving that A5 request writes a local generic `final_conclusions_v1` artifact and leaves the run `completed`
- **Local outcome seam**: `final_conclusions_v1` is now also surfaced through `orch_run_status` / `orch_run_export` as the current run's single-user outcome-facing SSOT; this still does not imply `research_outcome_v1` or REP publish
- **Local proposal lifecycle seam**: `autoresearch proposal-decision` / `orch_run_record_proposal_decision` now record a minimal local decision for the current run's current repair/skill/optimize/innovate proposal, which also powers duplicate suppression without introducing a new approval family
- **Project recent digest seam**: `orch_run_status` / `orch_run_export` now also surface a thin project-level `project_recent_digest` with recent runs, the latest readable `final_conclusions_v1`, the latest repair/skill/optimize/innovate proposals, and the latest active team summary without widening `orch_run_list`
- **Project surface drift seam**: `orch_run_status` / `orch_run_export` now also surface a diagnostic-only `project_surface_drift` block for stale legacy scaffold files and optional host-surface guidance noise; it warns without rewriting external project roots
- **Plan view fallback seam**: `autoresearch status` / `orch_run_status` now rebuild the plan view from `state.json#/plan` when derived `.autoresearch/plan.md` is missing or stale, instead of surfacing an empty/zeroed plan to agents
- **Resume / recovery seam**: `orch_run_status` / `orch_run_export` now surface the legacy-stable `resume_context`, the richer `recovery_context`, `current_run_workflow_outputs`, `current_run_workflow_outputs_source`, and `legacy_workflow_projection`; when durable workflow outputs are missing for an older run, they rebuild a best-effort legacy projection from ledger/artifact conventions, and `autoresearch init` also writes `.autoresearch/bin/autoresearch` so reconnecting agents in external projects can still execute the canonical `autoresearch status --json` front door even when the command is not on `PATH`
- **Single-user compute capability truth**: `orch_run_stage_idea` -> `orch_run_plan_computation` -> `orch_run_execute_manifest` is now the canonical generic lifecycle for staged compute execution; when the staged idea carries an explicit method bundle, planning materializes a provider-backed run-local manifest rather than narrating compute capability through the internal fixture runner
- **Recommended public stateful literature workflow entrypoint**: `autoresearch workflow-plan` (requires an initialized external project root; resolves recipes directly via `@autoresearch/literature-workflows`; persists `.autoresearch/state.json#/plan` and derives `.autoresearch/plan.md`)
- **Lightweight research brainstorm harness**: `autoresearch workflow-plan --recipe research_brainstorm --run-id 20260502T023000Z-m0-topic-r1 --topic "<topic>"` persists a planning-only brainstorm-to-`next_contract` handoff without invoking host-native thinking process, idea-engine, full research-team, broad retrieval, memory graph expansion, or a new root front door
- **Native TS run slice**: `autoresearch run` (requires an initialized external project root; runs prepared `computation/manifest.json` natively for `--workflow-id computation`, and also advances dependency-satisfied persisted workflow-plan steps through the same front door)
- **Dependency-map rendering front door**: `autoresearch graph --kind <claims|progress|literature>` consumes the domain-neutral `@autoresearch/shared/graph-viz` engine (already-built adapters) to render a Graphviz DOT dependency graph (plus optional PNG/SVG when Graphviz is present) — `claims` from a claim DAG (`claims.jsonl`/`edges.jsonl`), `progress` from a scaffolded `research_plan.md` (milestone/task graph), and `literature` from a citation/reference record set; takes explicit input paths so it needs no project root
- **Experimental TS idea runtime surface**: the current idea-engine phase is closed; `@autoresearch/idea-mcp` remains campaign/search/eval oriented on explicit external data roots, while `@autoresearch/idea-engine` keeps post-search `rank.compute` / `node.promote` and bounded negative failure-library reflection inside the runtime contract, not as a root front door or a new default capability lane
- **Current most mature domain MCP front door**: `@autoresearch/hep-mcp` exposed through `packages/hep-mcp/dist/index.js`
- **Current strongest end-to-end workflow family**: `hep_*` Project/Run + evidence + writing + export
- **Direct provider families**: `inspire_*`, `openalex_*`, `arxiv_*`, `hepdata_*`, `pdg_*`, `zotero_*`

## Current truthful workflows

- **Generic lifecycle workflow**: `autoresearch init/status/approve/pause/resume/export` (`export` now fails closed when no substantive payload is available); `init --refresh` re-applies the managed scaffold doc (`AGENTS.md`) into an existing project with per-file backups under `.autoresearch/backups/` and never rewrites user-owned seed files (`--dry-run` previews)
- **Higher-conclusion boundary workflow**: `autoresearch final-conclusions` / `orch_run_request_final_conclusions` gate A5 on canonical verification truth, and `approve` now consumes A5 into `final_conclusions_v1` on the existing approval/read-model surface rather than creating a second publication runtime
- **Verification-to-A5 bridge workflow**: `autoresearch verify` / `orch_run_record_verification` is now the single-user local front door that turns verification from pending truth into decisive `passed` / `failed` / `blocked` artifacts before A5 request/approve
- **Proposal lifecycle workflow**: `autoresearch proposal-decision` / `orch_run_record_proposal_decision` is now the thin local operator path for `accepted_for_later` / `dismissed` / `already_captured`, writing decision memory and dedupe state without turning proposals into a second gate family
- **Generic writing/review staging workflow**: `orch_run_stage_content` stages review/draft artifacts provider-neutrally into an existing run directory; provider-specific staging tools should remain thin adapters only
- **Generic follow-up continuation workflow**: `orch_run_progress_followups` is the canonical bounded consumer for computation-generated feedback and writing/review follow-ups; it progresses one follow-up task per call, consumes only explicit task/handoff authority, and does not invent scheduler or fallback semantics
- **Public stateful literature planning workflow**: `autoresearch workflow-plan` resolves literature recipes directly via `@autoresearch/literature-workflows` into bounded executable steps for an initialized external project root, persists the plan substrate into `.autoresearch/state.json#/plan`, and derives `.autoresearch/plan.md`
- **Agent-client continuation workflow**: `research-harness` recovers project truth first, then routes to `autoresearch`, `research-team`, `markdown-hygiene`, or `hep-mcp` as appropriate; `research-team` outputs are incomplete until durable conclusions are summarized or linked back into project artifacts and status files
- **Research brainstorm durable harness**: `research_brainstorm` captures context, candidate angles, screening, one recommendation, and a `next_contract` that may suggest `literature_landscape`, `literature_gap_analysis`, `derivation_cycle`, or `review_cycle`; the contract requires explicit approval and does not auto-start the heavier recipe or provide a built-in runnable tool chain
- **Native TS run workflow**: `autoresearch run` remains the only execution front door; `--workflow-id computation` executes a prepared `computation/manifest.json`, while persisted workflow-plan steps advance in a bounded loop until completion or a blocking failure is reached
- **Experimental idea campaign workflow**: `idea_campaign_init` -> `idea_search_step` / `idea_eval_run`, with `idea_campaign_topup` / `idea_campaign_pause` / `idea_campaign_resume` / `idea_campaign_complete` on `idea-mcp`; the closed phase does not reopen idea evolution scoring, memory graph, positive memory retrieval, broad retrieval, generic eval platform, or front-door expansion
- **Project/Run evidence workflow**: `hep_project_create` -> `hep_run_create` -> evidence build/query -> `hep_render_latex` -> `hep_export_project`
- **Writing/export workflow**: citation mapping, evidence build, verifier-enforced rendering, research pack export, paper scaffold export/import
- **Literature/data workflow**: direct provider search, retrieval, export, and bounded analysis operators
- **Local reference workflow**: Zotero Local API and offline PDG lookups

## Workflow-plan boundary

- `workflow-plan` 现在是公开的 stateful literature front door，且已把稳定的 typed `plan.execution` metadata 写入 `.autoresearch/state.json#/plan`。
- `.autoresearch/plan.md` 是派生 read model，不是机器编排 SSOT。
- `research_brainstorm` 是该 front door 下的 planning-only 轻量 durable harness recipe：它输出后续研究 handoff contract，不自动升级到重流程，也不成为 idea-engine、full research-team 或 root front door；持久化的 `research_brainstorm.*` step tools 不是内置 runnable tool chain。
- `autoresearch run` 现在是该 seam 的 canonical bounded consumer：它会推进 dependency-satisfied persisted workflow steps，直到完成或遇到 blocking failure，并继续保持唯一 execution front door。
- 当前 slice 仍未提供 canonical closed-loop literature execution runtime；这里还没有 full scheduler、多步自主编排或 end-to-end closed loop。

## State and artifact truth

- HEP data root resolution is project-aware: tool-call `project_root` writes under `<project_root>/artifacts/hep-mcp`; absent that, `HEP_DATA_DIR` is the explicit override; absent that, scratch fallback is `~/.autoresearch/hep-mcp`
- HEP project/run artifacts live under `projects/<project_id>/...` and `runs/<run_id>/...`
- Paper originals, extracted text, arXiv source tarballs, and source trees are filesystem materials: keep one-off checks in local temp, and persist verification/continuation inputs under the external project root in suitable project/run artifact directories
- Generic lifecycle state lives in external project roots under `.autoresearch/`
- Project-local durable memory lives alongside that state in files such as `research_plan.md`, `research_contract.md`, and substantive `research_notebook.md`; reconnecting agents should treat those files plus `.autoresearch/` as the enduring project truth
- `research_plan.md#Current Status` should stay readable as the human status entry for final target, current phase, completion state, blocker, next step, stop condition, and evidence pointers before the longer task board and log
- `research_notebook.md` should stay organized by the research problem's logic, not by date or status tracking; important literature notes require full-text/source-first reading, auditable section/page/equation/figure coverage, and LaTeX math notation; dated execution traces, raw run observations, and tool-use traces belong in `research_plan.md` or `artifacts/runs/<run_id>/`
- Human-facing project-local `run_id` values should be safe, sortable, readable research identities such as `20260502T023000Z-m3-branch-scan-r1`; provider UUIDs and `run_<uuid>` values remain machine/provider provenance rather than recommended artifact roots
- Approval packets are materialized under `artifacts/runs/<run_id>/approvals/<approval_id>/approval_packet_v1.json`
- Optional support surfaces such as `prompts/`, `team/`, `research_team_config.json`, `.mcp.template.json`, and root `specs/plan.schema.json` are created later by explicit project need or host-specific tooling, not by the default project scaffold

## Canonical docs

- [`README.md`](../README.md)
- [`docs/ARCHITECTURE.md`](./ARCHITECTURE.md)
- [`docs/TESTING_GUIDE.md`](./TESTING_GUIDE.md)
- [`docs/TOOL_CATEGORIES.md`](./TOOL_CATEGORIES.md)
