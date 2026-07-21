# project-contracts

Generic scaffold/contracts package for nullius project scaffolds, contract refresh, and project-root/output policy checks.

This package is intentionally narrow:

- one source of truth for scaffold template inventory and rendering,
- one source of truth for `research_notebook.md` -> `research_contract.md` sync,
- one source of truth for immutable main-report registration and structural validation,
- one source of truth for `real_project` root/output policy plus the lower-level internal maintainer-fixture guardrail.

Refresh mode (`ensure_project_scaffold(..., refresh=True)`, surfaced as `nullius init --refresh`) re-renders only the managed support file (`AGENTS.md`), backs up changed copies under `.nullius/backups/`, and never writes the user-owned seed files (`research_plan.md`, `research_notebook.md`, `research_contract.md`, `project_charter.md`, `project_index.md`, `reports/main_research_report_template.md`).

`nullius report-validate` delegates to this package. It checks the current-report
entry, immutable registered hashes, supersession relations, report structure,
human-readable evidence links, authoring-process leakage, and validation
classification. Implementation, input, and environment relations remain separate
fields; same implementation plus same input is replay regardless of environment
and cannot count as independent validation. Scientific sufficiency remains a
reviewer judgment rather than a structural check.

Report metadata, section fields, validation records, current pointers, and
registry rows count only as visible Markdown. Fenced code and ordinary HTML
comments cannot satisfy the contract; standard standalone marker comments only
delimit the authoritative regions. Every required report field occurs exactly
once in its assigned section.

For an existing project created before the main-report contract, `nullius init
--refresh` updates only managed guidance and does not migrate the user-owned
`project_index.md` or report template. Checkpoint the project, render a current
scaffold in a separate temporary external root with `nullius init --project-root
<temporary-root>`, copy only a missing
`reports/main_research_report_template.md`, and manually merge the temporary
`project_index.md#Main research report` section and empty registry into the
existing index. Never overwrite an existing template or index. Before that merge,
`nullius report-validate` fails closed with `invalid_registry_markers`; after the
empty registry is present it continues to fail with `no_current_report` until a
complete report is registered and selected.

Implementation language is incidental here: scaffold authority lives on the checked-in contracts/templates this package ships, not on a separate Python-branded front door.

Retired provider packages should not regain project-scaffold authority.
