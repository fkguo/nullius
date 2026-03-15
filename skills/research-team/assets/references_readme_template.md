# references/

This directory stores snapshots/exports of external sources used to build `knowledge_base/`.
Keep it simple and reproducible; avoid brittle parsers.

Skepticism policy:
- Snapshots are *evidence*, not guarantees of correctness.
- Prefer capturing the exact source text/data you relied on (so mistakes can be found), and record any errata/contradictions in the corresponding KB note.

Suggested structure:

- `references/inspire/`:
  - exported INSPIRE JSON/BibTeX
  - recid lists / query logs
- `references/arxiv_src/<arXiv-id>/`:
  - downloaded LaTeX source tarball
  - extracted sources (no parsing; treat as raw evidence)
  - Note: for old-style arXiv ids like `hep-ph/0109056`, use a normalized directory name like `hep-ph_0109056`.
- `references/github/<owner>__<repo>/`:
  - pinned code snapshot (commit hash recorded)
  - prefer `git submodule` or a shallow clone + commit hash log

Policy:
- Allowed network scope (default): prefer stable anchors (INSPIRE/arXiv/DOI/GitHub) + official docs/archives/registries (SciPy/Julia/NumPy/PyPI/Zenodo/etc.). General scholarly search may be used for discovery, but MUST be logged and final citations must be stabilized to stable anchors.
- Always log queries/decisions in `knowledge_base/methodology_traces/` and link them from `research_preflight.md`.
- Prefer LLM-assisted extraction from LaTeX sources into KB notes with explicit file pointers and normalization audits.
