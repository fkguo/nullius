# HEP Autoresearch

Evidence-first, reproducible workflow automation for High-Energy Physics (HEP): literature → derivations/code → numerics/reproduction → review/revision → writing/publishing.

This repository is the **orchestrator + reliability layer** that connects and standardizes an ecosystem:
- `hep-research-mcp`: INSPIRE/PDG/Zotero/paper source access/evidence indexing/writing export tools (MCP).
- `research-team`: milestone workflow + independent dual review + convergence gates.
- `hep-calc`: auditable symbolic/numeric computation orchestration (manifest/summary/analysis).
- `research-writer`: paper scaffold + citation/LaTeX hygiene + evidence gates.
- `review-swarm`: clean-room dual-model convergence checks (Opus + Gemini).

Language: English is the release default. Chinese docs are kept for bilingual publishing: see `README.zh.md`.

> Note: this repo was previously named `hep-research-autopilot`. The CLI keeps a compatibility alias (`hep-autopilot`). If you have local scripts that `cd hep-research-autopilot`, create a symlink next to the repo (e.g. `ln -s hep-autoresearch hep-research-autopilot`).

## Start here

1) `PROJECT_MAP.md` (project map)
2) `docs/VISION.md` (vision & scope)
3) `docs/ARCHITECTURE.md` (architecture & interfaces)
4) `docs/ROADMAP.md` (milestones & acceptance criteria)

## Quickstart

- Documentation index (English): `docs/INDEX.md`
- Beginner tutorial: `docs/BEGINNER_TUTORIAL.md` (English) / `docs/BEGINNER_TUTORIAL.zh.md` (Chinese)

## Status

2026-02-03: v0 executable loop is working, with reliability mechanisms gated by artifacts + evals:
- Installable CLI: `hep-autoresearch` (aliases: `hep-autopilot`, `hepar`)
- Web entry v0: FastAPI minimal panel (`src/hep_autoresearch/web/app.py`)
- Workflows v0: W1 ingest, W2 reproduce (toy + v1), W3 revision, W4 potential matrix checks
- Eval suite: `python3 scripts/run_evals.py --tag <TAG>`
- Default approval gates: compute-heavy runs (A3) and manuscript edits (A4) are enforced in the orchestrator

Human-readable entry point for latest artifacts: `artifacts/LATEST.md`
