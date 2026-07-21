# project_index.md

Project: <PROJECT_NAME>
Last updated: <YYYY-MM-DD>

This file is the single front door for the project root created by the shared scaffold rule.
Use it to find the human notebook, the machine contract, and the current plan without assuming any host-specific extras.

## Read first (in order)

1) [project_index.md](project_index.md) — checked-in front door for restart and navigation
2) [AGENTS.md](AGENTS.md) — workflow anchor, reconnect discipline, and output rules
3) [project_charter.md](project_charter.md) — goals, constraints, and declared profile
4) [research_plan.md](research_plan.md#current-status) — current status, task board, milestones, and progress log
5) [research_contract.md](research_contract.md) — machine-stable contract for gates, packets, and revision
6) [research_notebook.md](research_notebook.md) — living problem logic, derivations, interpretation, and figures, when it already contains substantive content
7) [Main research report](#main-research-report) — immutable researcher-facing report registry and current report entry point

The session-start, reconnect, recovery, and approval-boundary protocol lives in [AGENTS.md](AGENTS.md) — the managed scaffold file that `nullius init --refresh` keeps current. Follow it there before starting work; this file deliberately carries no copy of the protocol commands, because copies in user-owned files go stale.

## Core working surfaces

- Human status entry: [research_plan.md#Current Status](research_plan.md#current-status)
- Human notebook: [research_notebook.md](research_notebook.md)
- Main research report entry point: [Main research report](#main-research-report)
- Machine contract: [research_contract.md](research_contract.md)
- Canonical artifact root: `artifacts/runs/<run_id>/`
- Run identity rule: use a safe, sortable, readable `run_id` such as `<YYYYMMDDTHHMMSSZ>-<milestone>-<short-topic>-rN`; do not use bare UUIDs or `run_<uuid>` as human-facing research run names.

Keep the top of [research_plan.md](research_plan.md#current-status) readable as the current human status. Keep dated run logs and raw step summaries in [research_plan.md](research_plan.md) below that status section or in `artifacts/runs/<run_id>/`. Keep [research_notebook.md](research_notebook.md) organized by the research problem's logic so it remains readable as the project grows.
If the project creates literature notes, follow [AGENTS.md](AGENTS.md) for full-text/source-first reading, auditable coverage fields, clickable source links, and LaTeX math notation.

## Main research report

A checkpoint/status/closeout summary is a concise coordination artifact. A
main research report is a complete, independently reviewable scientific
narrative. Machine provenance binds execution but never substitutes for the
human-readable report or its clickable evidence chain.

Create each report by copying
[the domain-neutral report template](reports/main_research_report_template.md)
to a new stable path under `reports/`. Never overwrite a registered report.
When a conclusion changes or a report is incomplete, create a superseding
report, update both directions in the registry below, and switch the single
current pointer. The SHA-256 column makes later mutation structurally visible.

Complete every report field and add one structured record for each validation.
Fields must be visible Markdown and must occur exactly once in their assigned
section; fenced code and ordinary HTML comments do not count as report or
registry structure. Standard standalone marker comments only delimit the
authoritative regions.
The report must contain genuinely independent validation. Record implementation,
input, and environment relations separately. Same implementation plus same input
is replay regardless of environment and cannot be classified as independent.
A replay is useful only for a concrete declared risk: `randomness`, `parallelism`,
`cache`, `external_state`, or `unfixed_dependencies`. Machine provenance may bind
the record but cannot replace its explanatory narrative or human-readable link.
Run `nullius report-validate` before promotion. Its pass establishes structural
shape, link reachability, immutable registration, and supersession consistency;
scientific sufficiency remains a judgment on the reasoning and evidence.

<!-- MAIN_RESEARCH_REPORT_REGISTRY_START -->
- Current report ID: `(none yet)`
- Current report: `(none yet)`

| Report ID | Report | SHA-256 | Supersedes | Superseded by |
|---|---|---|---|---|
<!-- MAIN_RESEARCH_REPORT_REGISTRY_END -->

## Optional expansions

- Optional provider config, schema files, notes, references, or local automation surfaces are created later by explicit project need or host-specific tooling.
- Host-local support layers are opt-in support layers, not canonical root files or restart truth.
- Provider-local state directories should only appear when a provider or host layer explicitly needs them.

---

<!-- PROJECT_INDEX_AUTO_START -->
<!-- This block is auto-generated. Do not edit by hand. -->
<!-- PROJECT_INDEX_AUTO_END -->

## Notes (manual)

- (Optional) Add short “what changed / what’s blocked” notes here.
