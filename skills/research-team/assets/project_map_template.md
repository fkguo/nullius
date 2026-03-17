# project_index.md (Template)

Project: <PROJECT_NAME>
Last updated: <YYYY-MM-DD>

This file is the single navigation “front door”.
Goal: make the derivation chain, algorithm-design chain, evidence trail, and writing workflow discoverable in minutes.

## Read first (in order)

1) [project_charter.md](project_charter.md) — goals, constraints, scope
2) [research_plan.md](research_plan.md) — Task Board + Progress Log
3) [research_notebook.md](research_notebook.md) — human-readable derivations and interpretation
4) [research_contract.md](research_contract.md) — machine-stable contract for gates and revision
5) [AGENTS.md](AGENTS.md) — restart discipline and workflow anchor

## Latest pointers

- Latest pointers: [team/LATEST.md](team/LATEST.md)
- Latest team cycle: [team/LATEST_TEAM.md](team/LATEST_TEAM.md)
- Latest draft cycle: [team/LATEST_DRAFT.md](team/LATEST_DRAFT.md)
- Latest artifacts: [artifacts/LATEST.md](artifacts/LATEST.md)
- Trajectory index: [team/trajectory_index.json](team/trajectory_index.json)

## Optional HEP provider bundle

- Only add this bundle when the project explicitly uses the HEP provider/tooling path.
- Recommended `HEP_DATA_DIR` for this project (run from project root): `export HEP_DATA_DIR="$PWD/.hep-mcp"`
- Workspace config: [.hep/workspace.json](.hep/workspace.json)
  - Project-root-relative paths for HEP data/PDG/paper locations (v1: one project root → one MCP entry; local-only)
- Mapping log: [.hep/mappings.json](.hep/mappings.json)
  - Append-only with supersede semantics; conflicts should be treated as fail-fast
- Paper manifest (future): [paper/paper_manifest.json](paper/paper_manifest.json)

## Chains (what to follow)

### Derivation chain

- [research_contract.md](research_contract.md) — primary derivation + mapping to code/artifacts

### Algorithm / numerics design chain

- [research_preflight.md](research_preflight.md) — method selection rationale (incl. Problem Framing Snapshot)
- [knowledge_base/methodology_traces/](knowledge_base/methodology_traces/) — design decisions + search logs

### Evidence chain

- [team/LATEST.md](team/LATEST.md) — latest member A/B reports + adjudication
- [team/trajectory_index.json](team/trajectory_index.json) — long-horizon run ledger
- [knowledge_graph/](knowledge_graph/) — claim DAG + evidence manifest (if enabled)

### Writing chain

- Draft-cycle entry (agent or manual): `bash ~/.codex/skills/research-team/scripts/bin/run_draft_cycle.sh --tag D0-r1 --tex main.tex --bib refs.bib --out-dir team`
- Export bundle: `bash scripts/export_paper_bundle.sh --tag <TAG> --out export`

---

<!-- PROJECT_INDEX_AUTO_START -->
<!-- This block is auto-generated. Do not edit by hand. -->
<!-- PROJECT_INDEX_AUTO_END -->

## Notes (manual)

- (Optional) Add short “what changed / what’s blocked” notes here.
