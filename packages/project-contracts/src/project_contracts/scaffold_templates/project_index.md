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
6) [research_notebook.md](research_notebook.md) — human-readable problem logic, derivations, interpretation, and figures, when it already contains substantive content

If `.autoresearch/` exists, start by running `autoresearch status --json` before continuing work.
If `autoresearch` is unavailable on `PATH`, run `.autoresearch/bin/autoresearch status --json` instead.
- Treat `autoresearch` as the guaranteed root entrypoint for this scaffold.
- Treat that status output as the authoritative recovery briefing.
- When the host exposes orchestration or MCP control-plane commands such as `orch_*`, those host-local surfaces may be used as optional control planes; do not assume a literal `orch_*` command exists in every scaffolded project.
- Provider/domain MCP tools are capability sources, not root authority; do not treat provider MCPs such as `hep-mcp` as the generic root authority.
- If any A1-A5 approval is pending, stop there. Silence is never approval.
- If evidence is incomplete, mark the state `uncertain`, `abstained`, `unavailable`, or as a reading gap instead of writing a stronger conclusion.
- Then continue in order through [project_index.md](project_index.md), [AGENTS.md](AGENTS.md), [project_charter.md](project_charter.md), [research_plan.md](research_plan.md), [research_contract.md](research_contract.md), and [research_notebook.md](research_notebook.md) when it already contains substantive content.

## Core working surfaces

- Human status entry: [research_plan.md#Current Status](research_plan.md#current-status)
- Human notebook: [research_notebook.md](research_notebook.md)
- Machine contract: [research_contract.md](research_contract.md)
- Canonical artifact root: `artifacts/runs/<run_id>/`
- Run identity rule: use a safe, sortable, readable `run_id` such as `<YYYYMMDDTHHMMSSZ>-<milestone>-<short-topic>-rN`; do not use bare UUIDs or `run_<uuid>` as human-facing research run names.
- Shared docs: [docs/APPROVAL_GATES.md](docs/APPROVAL_GATES.md), [docs/ARTIFACT_CONTRACT.md](docs/ARTIFACT_CONTRACT.md), [docs/EVAL_GATE_CONTRACT.md](docs/EVAL_GATE_CONTRACT.md)

Keep the top of [research_plan.md](research_plan.md#current-status) readable as the current human status. Keep dated run logs and raw step summaries in [research_plan.md](research_plan.md) below that status section or in `artifacts/runs/<run_id>/`. Keep [research_notebook.md](research_notebook.md) organized by the research problem's logic so it remains readable as the project grows.
If the project creates literature notes, follow [AGENTS.md](AGENTS.md) for full-text/source-first reading, auditable coverage fields, clickable source links, and LaTeX math notation.

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
