# Idea posterior: moving between machines

### Moving between machines (synced projects)

Research projects are routinely synced across machines; everything this
skill writes is designed to survive that, provided one rule is respected:
**environments are machine-local, references are project-relative.**

- `gaia_package_ref` values are `project://` references resolved against
  the project root, so posteriors in the idea store stay auditable on
  every machine the project lands on. If a reference does not resolve
  (the package was moved or deleted after the write), re-run
  `run_infer_and_extract.py` on the package to produce a fresh posterior
  and reference — the `#sha256:` pin tells you whether the graph is still
  the same one.
- Virtual environments must NOT ride the sync: `.gaia-venv/` and each
  package's `.venv/` contain machine-specific binaries. Exclude them from
  the sync tool, and rebuild on the new machine: the recipe above
  recreates `.gaia-venv`; a package's own environment re-syncs
  automatically from its pinned `pyproject.toml` on the next gaia run (or
  explicitly with `uv sync --python 3.12` inside the package).
- If the project is also a git repository, prefer syncing it as a
  repository (push/pull) over letting a file-level sync service copy
  `.git/` — concurrent file-sync of repository internals can corrupt
  them.
