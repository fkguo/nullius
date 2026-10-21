# project_index.md

Project: <PROJECT_NAME>
Last updated: <YYYY-MM-DD>

This file is the single front door for the project root created by the shared scaffold rule.
Use it to find the human notebook, the machine contract, and the current plan without assuming any host-specific extras.

## Start here

Read [AGENTS.md](AGENTS.md) and [Current Status](research_plan.md#current-status),
then follow the task's evidence pointers. Read the charter/contract constraints
and original notebook/source sections needed for this question. Detailed
operation-specific rules live in [research_guidance.md](research_guidance.md).
Use the [main report registry](#main-research-report) for the promoted account.
Do not substitute a task brief or status summary for required original evidence.

The session-start, reconnect, recovery, and approval-boundary protocol lives in [AGENTS.md](AGENTS.md) — the project instructions that `nullius init --refresh` preserves when customized. Follow it there before starting work; this file deliberately carries no copy of the protocol commands, because copies in user-owned files go stale.

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

## Current results

The registry below is the project's answer to "what is the current best
result": one row per HEADLINE result object, each naming the run that
produced its current value and that run's effective code identity (the
commit whose tree is the code that ran). The machine never chooses which
result is best — selection is research judgment, made at milestone
convergence. The machine enforces the rest: result ids unique, exactly one
current row per result chain, the artifact present and matching its SHA-256,
and the named run stamped and still valid in the validity ledger. Rows are
written with `nullius result set-current` (hand edits stay legal; the same
checks validate either way). When a conclusion changes, register the
superseding row and keep both direction columns consistent, exactly like the
report registry above. Inside the block, every non-blank line must be a
table row or a single-line HTML comment; multi-line comments are reported
as malformed (fail-closed).

<!-- RESULT_REGISTRY_START -->
| Result ID | Description & artifact | Artifact SHA-256 | Current run | Supersedes | Superseded by |
|---|---|---|---|---|---|
<!-- RESULT_REGISTRY_END -->

## Optional expansions

- Optional provider config, schema files, notes, references, or local automation surfaces are created later by explicit project need or host-specific tooling.
- Host-local support layers are opt-in support layers, not canonical root files or restart truth.
- Provider-local state directories should only appear when a provider or host layer explicitly needs them.

---

<!-- RUN_INDEX_START -->
(machine-maintained run index — per-family map of every run directory; rendered by `nullius index sync` and refreshed automatically after ledger-writing commands; do not edit between these markers)
<!-- RUN_INDEX_END -->

## Notes (manual)

- (Optional) Add short “what changed / what’s blocked” notes here.
