# project-contracts

Neutral Python authority for autoresearch project scaffolds, contract refresh, and project-root/output policy checks.

This package is intentionally narrow:

- one source of truth for scaffold template inventory and rendering,
- one source of truth for `research_notebook.md` -> `research_contract.md` sync,
- one source of truth for `real_project` vs `maintainer_fixture` root/output policy.

`hep-autoresearch` remains a transitional consumer of this package in the current repo.
