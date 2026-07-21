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
human-readable evidence links, and validation classification. Scientific
sufficiency remains a reviewer judgment rather than a structural check.

Implementation language is incidental here: scaffold authority lives on the checked-in contracts/templates this package ships, not on a separate Python-branded front door.

Retired provider packages should not regain project-scaffold authority.
