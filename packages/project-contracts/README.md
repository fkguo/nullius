# project-contracts

Generic scaffold/contracts package for autoresearch project scaffolds, contract refresh, and project-root/output policy checks.

This package is intentionally narrow:

- one source of truth for scaffold template inventory and rendering,
- one source of truth for `research_notebook.md` -> `research_contract.md` sync,
- one source of truth for `real_project` root/output policy plus the lower-level internal maintainer-fixture guardrail.

Refresh mode (`ensure_project_scaffold(..., refresh=True)`, surfaced as `autoresearch init --refresh`) re-renders only the managed support file (`AGENTS.md`), backs up changed copies under `.autoresearch/backups/`, and never writes the user-owned root seed files (`research_plan.md`, `research_notebook.md`, `research_contract.md`, `project_charter.md`, `project_index.md`).

Implementation language is incidental here: scaffold authority lives on the checked-in contracts/templates this package ships, not on a separate Python-branded front door.

Retired provider packages should not regain project-scaffold authority.
