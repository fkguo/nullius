# PROJECT_MAP.md (Template)

Project: <PROJECT_NAME>
Last updated: <YYYY-MM-DD>

This file is the single navigation “front door”.
Goal: make the derivation chain, algorithm-design chain, evidence trail, and writing workflow discoverable in minutes.

## Read first (in order)

1) [PROJECT_CHARTER.md](PROJECT_CHARTER.md) — goals, constraints, scope
2) [RESEARCH_PLAN.md](RESEARCH_PLAN.md) — Task Board + Progress Log
3) [PREWORK.md](PREWORK.md) — literature coverage + method selection
4) [Draft_Derivation.md](Draft_Derivation.md) — full derivation chain (no skipped steps)

## Latest pointers

- Latest pointers: [team/LATEST.md](team/LATEST.md)
- Latest team cycle: [team/LATEST_TEAM.md](team/LATEST_TEAM.md)
- Latest draft cycle: [team/LATEST_DRAFT.md](team/LATEST_DRAFT.md)
- Latest artifacts: [artifacts/LATEST.md](artifacts/LATEST.md)
- Trajectory index: [team/trajectory_index.json](team/trajectory_index.json)

## Ecosystem front door (hep-research-mcp)

- Recommended `HEP_DATA_DIR` for this project (run from project root): `export HEP_DATA_DIR="$PWD/.hep-research-mcp"`
- Workspace config: [.hep/workspace.json](.hep/workspace.json)
  - Project-root-relative paths for HEP data/PDG/paper locations (v1: one project root → one MCP entry; local-only)
- Mapping log: [.hep/mappings.json](.hep/mappings.json)
  - Append-only with supersede semantics; conflicts should be treated as fail-fast
- Paper manifest (future): [paper/paper_manifest.json](paper/paper_manifest.json)

## Chains (what to follow)

### Derivation chain

- [Draft_Derivation.md](Draft_Derivation.md) — primary derivation + mapping to code/artifacts

### Algorithm / numerics design chain

- [PREWORK.md](PREWORK.md) — method selection rationale (incl. Problem Framing Snapshot)
- [knowledge_base/methodology_traces/](knowledge_base/methodology_traces/) — design decisions + search logs

### Evidence chain

- [team/LATEST.md](team/LATEST.md) — latest member A/B reports + adjudication
- [team/trajectory_index.json](team/trajectory_index.json) — long-horizon run ledger
- [knowledge_graph/](knowledge_graph/) — claim DAG + evidence manifest (if enabled)

### Writing chain

- Draft-cycle entry (agent or manual): `bash ~/.codex/skills/research-team/scripts/bin/run_draft_cycle.sh --tag D0-r1 --tex main.tex --bib refs.bib --out-dir team`
- Export bundle: `bash scripts/export_paper_bundle.sh --tag <TAG> --out export`

---

<!-- PROJECT_MAP_AUTO_START -->
<!-- This block is auto-generated. Do not edit by hand. -->
<!-- PROJECT_MAP_AUTO_END -->

## Notes (manual)

- (Optional) Add short “what changed / what’s blocked” notes here.
