# workflows/

This folder contains **executable, testable workflow blueprints** (more structured than `docs/WORKFLOWS.md`).

Chinese version: `workflows/README.zh.md`.

Conventions:
- Every workflow document must include: inputs, artifacts, gates/acceptance, MVP scope, and extension roadmap (v1/v2).
- Any new automation capability must also:
  1) update an existing workflow doc (or add a new workflow), and
  2) add/update at least one eval case under `evals/`.

Current workflows:
- `workflows/ingest.md`: paper ingestion (INSPIRE/arXiv/DOI → references + reading note)
- `workflows/reproduce.md`: reproduction-first (reproduce headline results)
- `workflows/computation.md`: generic compute DAG (run_card v2) → auditable artifacts + resume
- `workflows/draft.md`: draft writing (Draft_Derivation/KB → compilable draft)
- `workflows/revision.md`: review → revise loop (LaTeX)
- `workflows/paper_reviser.md`: paper-reviser integration + verification loop (A–E; A1-gated retrieval)
- `workflows/derivation_check.md`: derivation + consistency checks (including limits/invariants)
- `workflows/C1_literature_gap.md`: MCP INSPIRE literature discovery bundle (Phase C1)
- `workflows/C2_method_design.md`: method design scaffold → runnable computation plugin project (Phase C2)
