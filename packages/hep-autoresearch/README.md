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

1) `docs/INDEX.md` (documentation index)
2) `docs/BEGINNER_TUTORIAL.md` (first external-project walkthrough)
3) `docs/VISION.md` (vision & scope)
4) `docs/ARCHITECTURE.md` (architecture & interfaces)

Important: this package repo is the **development home** of `hep-autoresearch`, not the research-project root you operate on day to day. Run `hep-autoresearch init` inside your own research project directory to scaffold the minimal core surface: `project_charter.md`, `project_index.md`, `research_plan.md`, `research_notebook.md`, `research_contract.md`, a provider-neutral `.mcp.json.example`, `.autoresearch/`, `docs/`, and `specs/`. Research-team-only surfaces such as `prompts/`, `research_team_config.json`, `knowledge_base/`, `references/`, and `team/` are now optional full-scaffold additions rather than canonical defaults; provider-local HEP surfaces such as `.hep/` are opt-in rather than part of the shared scaffold baseline.

## Quickstart

- Documentation index (English): `docs/INDEX.md`
- Beginner tutorial: `docs/BEGINNER_TUTORIAL.md` (English) / `docs/BEGINNER_TUTORIAL.zh.md` (Chinese)

## Status

2026-02-03: v0 executable loop is working, with reliability mechanisms gated by artifacts + evals:
- Installable CLI: `hep-autoresearch` (aliases: `hep-autopilot`, `hepar`)
- Web entry v0: FastAPI minimal panel (`src/hep_autoresearch/web/app.py`)
- Workflows v0: ingest, reproduce, computation, revision, literature survey polish, and orchestrator/eval regressions
- Eval suite: `python3 scripts/run_evals.py --tag <TAG>`
- Default approval gates: compute-heavy runs (A3) and manuscript edits (A4) are enforced in the orchestrator

Maintainer artifact entry point for latest checked-in runs: `artifacts/LATEST.md`
