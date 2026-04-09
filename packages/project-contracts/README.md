# project-contracts

Generic scaffold/contracts package for autoresearch project scaffolds, contract refresh, and project-root/output policy checks.

This package is intentionally narrow:

- one source of truth for scaffold template inventory and rendering,
- one source of truth for `research_notebook.md` -> `research_contract.md` sync,
- one source of truth for `real_project` root/output policy plus the lower-level internal maintainer-fixture guardrail.

Implementation language is incidental here: scaffold authority lives on the checked-in contracts/templates this package ships, not on a separate Python-branded front door.

`hep-autoresearch` remains a provider-local internal consumer of this package in the current repo.
