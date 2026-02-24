---
name: research-writer
description: Scaffold or validate an arXiv-ready RevTeX4-2 (12pt, onecolumn) paper from a `research-team` project, with provenance wiring, BibTeX hygiene, and deterministic Markdown/LaTeX checks (optional Claude+Gemini section drafting).
---

# Research Writer

Agent-first skill: given an existing `research-team` project root (with `Draft_Derivation.md`, `knowledge_base/`, and `artifacts/`), scaffold a **coherent, arXiv-ready paper folder** and provide deterministic hygiene checks so the draft is auditable and safe to iterate.

Key entry points:
- `scripts/bin/research_writer_scaffold.sh`: deterministic scaffold `paper/` from a `research-team` project.
- `scripts/bin/research_writer_draft_sections.sh`: opt-in section drafting (writer → auditor) with trace logs + evidence gate.
- `scripts/bin/research_writer_consume_paper_manifest.sh`: deterministic “publisher” for an MCP-exported `paper/` scaffold (validate/hygiene/optional compile).

> Note: the `.sh` entry points are thin wrappers around the corresponding `.py` CLIs and accept the same flags (so `--help` works either way).

Default paper style:
- RevTeX 4.2, `12pt`, `onecolumn` (English-first).

## Prereqs

Required:
- `bash`, `python3`

Optional (only needed for specific workflows):
- TeX toolchain (e.g., TeX Live/MiKTeX) with RevTeX 4.2; `latexmk` for `--compile` (consume-manifest path).
- Network access for `--fetch-bibtex` (INSPIRE/DOI).
- Local `claude` + `gemini` CLIs (and their runner skills) for `--run-models` (draft-sections path).

## Run-card + export manifest (hep-autoresearch interop)

All three main entry points accept an optional `--run-card <path>`:
- The run-card is treated as an **opaque JSON blob**: it is copied verbatim into the output directory (no schema assumptions).
- A best-effort **summary** (`run_id`, `backend`, `approval_trace_id`, …) is logged into `paper/run.json` (scaffold/draft-sections) or `paper/build_trace.jsonl` (consume).

All entry points also write a minimal `export_manifest.json` to help upstream orchestrators (e.g., `hep-autoresearch`) import the paper output into their own `artifacts/` layout.

## Quick start (one-shot scaffold)

```bash
bash scripts/bin/research_writer_scaffold.sh \
  --project-root /path/to/research-team-project \
  --tag M1-r1 \
  --out paper/
```

Scaffold outputs (`--out paper/`):
- `paper/main.tex`
- `paper/references.bib`
- `paper/figures/` (created; may symlink/copy an artifacts figure if one is discoverable)
- `paper/latexmkrc`
- `paper/README.md`
- `paper/run.json` (run metadata; includes run-card pointer/summary if provided)
- `paper/export_manifest.json` (minimal export for upstream tooling)
- If `--run-card`: `paper/run_card.json` (or `paper/run_card.<sha12>.json`)

Optional (best-effort online BibTeX fetch from INSPIRE/DOI; writes `paper/bibtex_trace.jsonl`):

```bash
bash scripts/bin/research_writer_scaffold.sh \
  --project-root /path/to/research-team-project \
  --tag M1-r1 \
  --out paper/ \
  --fetch-bibtex
```

## Optional: draft sections (opt-in; writer → auditor)

This is an **opt-in** helper that produces a single human-readable `*_final.tex` per section, while preserving the writer draft, a unified diff, and trace logs. It does **not** modify `paper/main.tex`.

It will only call external LLM CLIs if you pass `--run-models` (otherwise use `--stub-models` or `--dry-run`).

```bash
bash scripts/bin/research_writer_draft_sections.sh \
  --project-root /path/to/research-team-project \
  --paper-dir paper/ \
  --tag M1-r1 \
  --run-id D1 \
  --all \
  --run-models
```

Outputs are written under `paper/drafts/<run-id>/`:
- `draft_<section>_writer.tex` (raw writer draft)
- `draft_<section>_final.tex` (auditor-revised; primary file for humans)
- `draft_<section>.diff` (writer → final unified diff)
- `trace.jsonl` + `run.json` (auditable run log/config)
- `export_manifest.json` (minimal export for upstream tooling)
- If `--run-card`: `run_card.json` (or `run_card.<sha12>.json`)
- If the evidence gate fails: `draft_<section>_unsafe.tex` + `evidence_gate_report_<section>.md`

Advanced flags (optional; see `--help` for full surface):
- Models: `--writer-model` (default: `opus`), `--auditor-model` (default: `gemini-3-pro-preview`)
- Runner scripts: `--claude-runner` / `--gemini-runner` point to `run_claude.sh` / `run_gemini.sh` (defaults are auto-detected under `$CODEX_HOME/skills/`)
- Evidence gate: `--evidence-scan=all|macros` (default `all`); if `macros`, set one or more `--evidence-macro` (e.g. `revadd`)
- Testing: `--stub-models` (no external calls), `--stub-variant=safe|unsafe` (`unsafe` should fail the evidence gate by design)

## Consume an MCP-exported paper scaffold (deterministic publisher)

If `hep-research-mcp` (or another agent pipeline) already produced a `paper/` directory, this skill can validate + apply deterministic hygiene + (optionally) compile it using `paper/paper_manifest.json` as the only entrypoint.

From the project root (default manifest path `paper/paper_manifest.json`):

```bash
bash scripts/bin/research_writer_consume_paper_manifest.sh --compile
```

Or explicitly:

```bash
bash scripts/bin/research_writer_consume_paper_manifest.sh \
  --paper-manifest /path/to/paper/paper_manifest.json \
  --compile
```

Outputs:
- `paper/build_trace.jsonl` (audit log: checksums, validate results, hygiene/compile actions)
- `paper/export_manifest.json` (minimal export for upstream tooling; includes compile status + run-card pointer if provided)

`--compile` runs `latexmk -pdf main.tex` if `latexmk` is available; otherwise it records a deterministic `SKIPPED` result in `paper/build_trace.jsonl` (not a failure).

## Calling from hep-autoresearch (recommended pattern)

`hep-autoresearch` (or any orchestrator) should:
1) Prepare a JSON run-card that records prompts/tools/approvals (owned by the orchestrator).
2) Call `research-writer` with `--run-card` so the paper output is self-describing and traceable.
3) Ingest `paper/export_manifest.json` and copy/snapshot the referenced files into the orchestrator’s `artifacts/` structure (owned by the orchestrator).

Example smoke (scaffold + run-card; optional compile):

```bash
cat > /tmp/run_card.json <<'JSON'
{"run_id":"SMOKE-1","workflow_id":"W3_draft","backend":{"name":"research-writer"}}
JSON

bash scripts/bin/research_writer_scaffold.sh \
  --project-root /path/to/research-team-project \
  --tag SMOKE-1 \
  --out /tmp/paper_smoke \
  --run-card /tmp/run_card.json

# Optional: compile (if latexmk exists)
if command -v latexmk >/dev/null 2>&1; then (cd /tmp/paper_smoke && latexmk -pdf main.tex); fi
```

Upstream “artifacts triplet” example mapping (done by the orchestrator, not this skill):
- `artifacts/runs/<run_id>/run_card.json`: copy the orchestrator’s run-card (or the `paper/run_card*.json` captured by this skill).
- `artifacts/runs/<run_id>/manifest.json`: store `paper/export_manifest.json` (or embed it).
- `artifacts/runs/<run_id>/analysis.json`: store compile summaries/warnings extracted from the paper build (or from `paper/build_trace.jsonl` if you use the consume step).

## Translations

- Chinese: `SKILL.zh.md` (best-effort; `SKILL.md` remains the SSOT for the contract).

## What it does (conceptually)

1) Reads `Draft_Derivation.md` and builds a paper skeleton that **points back to source sections** (no hallucinated derivations).
2) Pulls headline numbers/figures from `artifacts/` manifests/summaries and writes a **Results provenance** table (artifact path + JSON/CSV key).
3) Produces a BibTeX file with **RevTeX4-2 hygiene** (APS-style safety: ensure `@article` has `journal = ""` if unknown).
4) Runs deterministic hygiene checks, including the **double-backslash-in-math** bug (`\\Delta` instead of `\Delta`) with optional auto-fix.

## Hard policies (must follow)

1) **Scientific skepticism is mandatory**: any external claim used in core reasoning/headline results must be either:
   - independently validated (derivation, limit check, or artifact reproduction), or
   - labeled `UNVERIFIED` with a validation plan + kill criterion.
2) **No hard cutoff on real workflows**: citations/links to software/data archives are allowed (Zenodo/Figshare/institutional repos/experiment pages). Prefer stable anchors; require trace logging rather than forbidding.
3) **Network/DNS robustness**: if metadata/BibTeX fetch fails, degrade gracefully by writing stable links + minimal placeholders for later backfill.
4) **Markdown/LaTeX hygiene**: avoid accidental LaTeX over-escaping in math; provide deterministic check + optional deterministic fix.

## Out of scope

This skill does **not**:
- run the underlying simulations/derivations that produce `artifacts/`
- guarantee compilation success (TeX environment must be configured)
- replace human scientific review (the evidence gate is a heuristic safety net)
- submit to arXiv / journals

## Artifact contract (inputs)

This skill assumes a `research-team`-style project root, with best-effort fallbacks.

### Required
- `Draft_Derivation.md` — primary derivation notebook (source of equations/definitions; paper must cite/point to sections, not invent missing steps).

### Strongly recommended
- `knowledge_base/` — background, priors, methodology traces, and reference notes (for auditability and “UNVERIFIED” validation plans).
- `artifacts/` — reproducibility outputs for a given tag (see below).

### Artifacts: accepted layouts (best-effort detection)

For a given `--tag <TAG>`, the scaffold searches (in order):
- `artifacts/runs/<TAG>/` (preferred)
- `artifacts/<TAG>/`
- `artifacts/<TAG>_manifest.json` + `artifacts/<TAG>_analysis.json` (demo layout)

Within an artifacts run dir, common files are recognized:
- `manifest.json` / `*_manifest.json`
- `summary.json` / `summary.csv`
- `analysis.json` / `*_analysis.json`

Minimum expectations for provenance:
- A manifest lists produced outputs (plots/tables/data paths) and (ideally) parameters/versions.
- A summary/analysis provides headline numbers with definitions/keys.

## Deterministic hygiene tools

- Double-backslash math check/fix (Markdown math only): see `scripts/bin/check_md_double_backslash.sh` and `scripts/bin/fix_md_double_backslash_math.py`.
- Evidence-gate checker (revision additions via `\revadd{...}`, or full-text via `--scan-all`): see `scripts/bin/check_latex_evidence_gate.py`.
- BibTeX RevTeX 4.2 hygiene: see `scripts/bin/fix_bibtex_revtex4_2.py`.
- BibTeX fetch trace (when `--fetch-bibtex` is used): see `paper/bibtex_trace.jsonl`.

## Style profile (FK voice)

Use the FK style guide when drafting or rewriting text:
- `assets/style/style_profile.md`
- `assets/style/writing_voice_system_prompt.txt`
- Anti-hallucination guardrails (evidence gate): `assets/style/research_writer_guardrails_system_prompt.txt`
- Physics discussion logic playbook: `assets/style/physics_discussion_logic_playbook.md`
- Exemplar corpus downloader (INSPIRE → arXiv sources): `assets/style/prl_style_corpus.md` (script: `scripts/bin/fetch_prl_style_corpus.py`)
- Additional exemplar corpus (PRL hep-ph multi-author filter): `assets/style/prl_style_corpus_hep_ph_multi_author.md`
- N=10 reading-pack generator (corpus → per-paper excerpts + optional dual-model argument maps): `scripts/bin/research_writer_learn_discussion_logic.py` (writes `PROGRESS.md`/`PROGRESS.json` into `--out-dir`)
- Deterministic distiller (dual-model outputs → consensus/disagreement reports): `scripts/bin/distill_discussion_logic.py` (writes `distill/` under the chosen `--out-dir`)

Example (prepare N=10 packs; recommended masking on):

```bash
python3 scripts/bin/research_writer_learn_discussion_logic.py \
  --query-url "https://inspirehep.net/literature?sort=mostrecent&size=50&page=1&q=%28a%20f%20k%20guo%20or%20a%20u%20g%20meissner%20or%20a%20m%20hoferichter%29%20and%20j%20phys.rev.lett." \
  --fetch \
  --fetch-n 50 \
  --n 10 \
  --resume \
  --out-dir /tmp/research_writer_discussion_logic \
  --mask-math \
  --mask-cites
```

Example (distill a completed run into auditable reports):

```bash
python3 scripts/bin/distill_discussion_logic.py \
  --out-dir "/home/user/Nutstore Files/Coding/research_writer_discussion_logic/prl_hep-ph_xdj_hxz_fy_jz_mpospelov"
```

## Operational docs

- Quickstart: `README.md`
- Workflows/debugging: `RUNBOOK.md`
- Milestones/acceptance criteria: `ROADMAP.md`
