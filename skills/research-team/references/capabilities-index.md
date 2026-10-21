Command, script and asset paths in this reference are relative to the `research-team` skill directory. Markdown links are relative to this reference. Cross-section names follow the routes in [SKILL.md](../SKILL.md).

## Capabilities index (discoverability)

- **Team cycle (core)**: `scripts/bin/run_team_cycle.sh` (preflight → A/B → convergence).
- **Draft (TeX) review cycle**: `scripts/bin/run_draft_cycle.sh` (TeX-source-first; optional 3-party convergence).
- **Autopilot**: `scripts/bin/run_autopilot.sh` (plan autofill + loop coordinator; uses `scripts/bin/autopilot_loop.py`).
- **Packet build only**: `scripts/bin/build_team_packet.py`, `scripts/bin/build_draft_packet.py`.
- **Literature fetch (INSPIRE/arXiv/Crossref/DataCite/DOI/GitHub)**: `scripts/bin/literature_fetch.py` (project-leader source-adapter helper for prework/KB building; reviewers must not use network).
  - Read [`references/capabilities-detail.md`](capabilities-detail.md) when running `literature_fetch.py` or maintaining the literature query and saturation records (the sub-bullets of the literature-fetch entry, moved there verbatim).
- **Derive the contract's notebook-sync block**: `scripts/bin/refresh_research_contract.py --root /path/to/project`. It writes the derived block to `artifacts/research_contract_block.proposed.md` and **does not modify `research_contract.md` at all** — merge what is right into the contract's sync block by hand.
  - Read [`references/capabilities-detail.md`](capabilities-detail.md) when running `refresh_research_contract.py` or reasoning about the derived notebook-sync block (the sub-bullets of the contract-block entry, moved there verbatim).
- **Export a portable bundle**: `scripts/bin/export_paper_bundle.sh` (wrapper) / `scripts/bin/export_paper_bundle.py`.
- **KB index export (deterministic/L1)**: `scripts/bin/kb_export.py` + `scripts/bin/validate_kb_index.py` + `scripts/schemas/kb_index.schema.json`.
- **Demo generation**: `scripts/bin/generate_demo_milestone.sh`.
- **Project kickstart prompt**: `scripts/bin/generate_project_start_prompt.py`.
- **Deterministic hygiene tools** (as needed): `scripts/bin/fix_markdown_*`, `scripts/bin/fix_bibtex_revtex4_2.py`, `scripts/bin/upgrade_reference_anchors.py`; use the standalone `markdown-hygiene` skill for manual Markdown math/TOC cleanup outside a team-cycle preflight.
- **Claim DAG & evidence** (optional): render via `nullius graph --kind claims` (the domain-neutral `@nullius/shared/graph-viz` front door; auto-rendered best-effort to `knowledge_graph/` at convergence when an `nullius` CLI is reachable) + gates under `scripts/gates/`.
- **Roadmap dependency-map (plan-summary / milestone-handoff)**: `assets/roadmap_dependency_map_template.md` + `nullius graph --kind roadmap` (a *planning* view of milestones/lanes; complements — does not replace — the Claim DAG; see [roadmap dependency-map details](roadmap-and-report-promotion.md)).
- **Exploration stage debt helper**: `scripts/bin/exploration_debt_dashboard.py`.
- **Scaffold pruning (move/archive optional files)**: `scripts/bin/prune_optional_scaffold.py`.
- **Environment snapshot**: `scripts/bin/capture_env_snapshot.sh`.
- **Executor navigation and progress**: `scripts/bin/update_project_map.py`, `scripts/bin/update_research_plan_progress.py`, `scripts/bin/update_trajectory_index.py`.
- **Main research report promotion**: the canonical domain-neutral template
  and registry live in the `project-contracts` scaffold under
  `reports/main_research_report_template.md` and
  `project_index.md#Main research report`; validate promotion with
  `nullius report-validate`. This skill consumes that authority and does not
  carry a second template.
- Read [`references/capabilities-detail.md`](capabilities-detail.md) when looking for a secondary utility (autofill, tag helpers, claim gates, post-run helpers, diagnostics, adjudication, member review) (the secondary-utilities entry, moved there verbatim).

Read [`references/parallel-worktree-lanes.md`](parallel-worktree-lanes.md) when independent workstreams run as separate git worktrees or branches driven by separate agents (the section on judgment-point stops and merge authority, moved there verbatim).
