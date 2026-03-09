# research-writer — maintainer guide (and calling-contract supplement)

This directory is a Codex skill repo: `research-writer`.

- **Calling contract SSOT**: `SKILL.md` (for users / callers)
- **Workflow & maintenance conventions**: this `AGENTS.md` (for maintainers / contributors)

Goal: allow a new maintainer to **call the skill correctly without reading code**, and to safely develop + validate changes by reading only a few key files.

## Quick validation (run after changes)

- Smoke tests (covers major CLIs `--help`, offline fixtures, stub models, `latexmk` compile, etc.): `bash scripts/dev/run_all_smoke_tests.sh`

## Entry points & calling contract (summary)

Convention: unless explicitly requested, do not trigger network access or external model calls. Each entry point below notes network/model behavior.

### 1) Scaffold: generate `paper/` from a `research-team` project (deterministic by default; optional network)

- Entry: `bash scripts/bin/research_writer_scaffold.sh ...`
- Purpose: build a compilable RevTeX 4.2 `paper/` skeleton from `Draft_Derivation.md` + `artifacts/` (best-effort), with deterministic BibTeX/LaTeX/Markdown hygiene.
- Required inputs:
  - `--project-root <DIR>`: `research-team` project root
  - `--tag <TAG>`: run/tag for locating `artifacts/` (e.g. `M1-r1`)
  - `--out <DIR>`: output directory (e.g. `paper/`)
- Primary outputs (written under `--out`):
  - `main.tex`, `references.bib`, `latexmkrc`, `figures/`, `README.md`, `run.json`, `export_manifest.json`
  - If `--run-card`: copies the run-card JSON (`run_card.json` / `run_card.<sha12>.json`)
  - If `--fetch-bibtex`: also writes `bibtex_trace.jsonl`
- Network: only with `--fetch-bibtex` (INSPIRE/DOI; best-effort; degrades gracefully and records trace).

### 2) Draft sections: optional per-section drafting (default no models; optional Claude+Gemini)

- Entry: `bash scripts/bin/research_writer_draft_sections.sh ...`
- Purpose: produce `*_writer.tex` (writer) and `*_final.tex` (auditor) per section, plus diff + trace; does **not** modify `paper/main.tex`.
- Model calls: no external calls by default. Only `--run-models` calls local `claude`/`gemini` CLIs (via runner scripts).
- Output dir: default `paper/drafts/<run-id>/` (override via `--out-dir`)
- Key safety switches:
  - `--dry-run`: write prompts/trace only; no model calls
  - `--stub-models`: deterministic stubs (for tests/CI)
  - `--stub-variant safe|unsafe`: `unsafe` intentionally triggers the evidence gate (for gate validation)
  - evidence gate: default `--evidence-scan=all`; can switch to `macros` and specify `--evidence-macro` (e.g. `revadd`)
- Runner + model config:
  - `--writer-model` default `opus`
  - `--auditor-model` default `gemini-3-pro-preview`
  - `--claude-runner` / `--gemini-runner`: runner script paths; if omitted, auto-detect under `$CODEX_HOME/skills/`

### 3) Consume paper manifest: deterministic publisher for MCP-exported `paper/` (no network / no models)

- Entry: `bash scripts/bin/research_writer_consume_paper_manifest.sh ...`
- Purpose: use `paper/paper_manifest.json` as the only entrypoint; fail-fast validate, apply deterministic Bib layering hygiene, and optionally compile with `latexmk`; write audit log `paper/build_trace.jsonl`.
- Network: none
- Models: none
- Compile: only runs when `--compile` is set and `latexmk` exists; otherwise records `SKIPPED` (not a failure).

## Code / documentation conventions

- **When adding/changing CLI flags**: update `SKILL.md` (calling contract) and add at least one runnable smoke/fixture coverage (usually in `scripts/dev/run_all_smoke_tests.sh`).
- **Determinism**: except for `--fetch-bibtex` and `--run-models`, keep behavior deterministic and offline-reproducible.
- **`.sh` vs `.py`**: `.sh` scripts are thin wrappers; flags should match the corresponding `.py` CLIs. Prefer `.sh` in docs; `--help` can point to `.py`.
- **Maintainer-local review artifacts**: `team/reviews/` is for local milestone packets / reviewer outputs only. Do not check it into the repo; keep only reusable prompt assets outside that subtree.

## Common dependencies (for development/debugging)

- Baseline: `bash`, `python3`
- Optional compile: TeX distribution + RevTeX 4.2 + `latexmk`
- Optional `--run-models`: local `claude` and `gemini` CLIs; and `$CODEX_HOME/skills/claude-cli-runner`, `$CODEX_HOME/skills/gemini-cli-runner`
