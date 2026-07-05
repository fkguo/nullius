---
name: research-writer
description: Scaffold or validate an arXiv-ready RevTeX4-2 (12pt, onecolumn) paper from a `research-team` project, with provenance wiring, BibTeX hygiene, and deterministic Markdown/LaTeX checks (optional multi-backend section drafting).
---

# Research Writer

Agent-first skill: given an existing `research-team` project root (with `research_notebook.md`, `research_contract.md`, `knowledge_base/`, and `artifacts/`), scaffold a **coherent, arXiv-ready paper folder** and provide deterministic hygiene checks so the draft is auditable and safe to iterate.

Key entry points:
- `scripts/bin/research_writer_scaffold.sh`: deterministic scaffold `paper/` from a `research-team` project.
- `scripts/bin/research_writer_draft_sections.sh`: opt-in section drafting (writer → auditor) with trace logs + evidence gate.
- `scripts/bin/research_writer_consume_paper_manifest.sh`: deterministic “publisher” for an MCP-exported `paper/` scaffold (validate/hygiene/optional compile).

> Note: the `.sh` entry points are thin wrappers around the corresponding `.py` CLIs and accept the same flags (so `--help` works either way).

Default paper style:
- RevTeX 4.2, `12pt`, `onecolumn` (English-first).

## Which path do I want?

- **Scaffold a new paper** from a research-team project → `research_writer_scaffold.sh` (Quick start below).
- **Draft/revise section prose** (writer → auditor, evidence-gated) → `research_writer_draft_sections.sh` (opt-in).
- **Ground every claim in ingested sources** (when hep-mcp is available) → the evidence-grounded workflow.
- **Publish an MCP-exported `paper/`** (validate + hygiene + optional compile) → `research_writer_consume_paper_manifest.sh`.
- **Check a draft before delivery** → the deterministic hygiene tools (math, cross-refs/citations, evidence gate, result-traceability, arXiv packaging).
- **Tracked-change revision / response-to-referee** on a finished LaTeX manuscript → the sibling `paper-reviser` skill (this skill scaffolds + checks; it does not own the revise/resubmit cycle).

## Prereqs

Required:
- `bash`, `python3`

Optional (only needed for specific workflows):
- TeX toolchain (e.g., TeX Live/MiKTeX) with RevTeX 4.2; `latexmk` for `--compile` (consume-manifest path).
- Network access for `--fetch-bibtex` (INSPIRE/DOI).
- Local `claude` + `gemini` CLIs (and their runner skills) for `--run-models` (draft-sections path).

## Run-card + export manifest (orchestrator interop)

All three main entry points accept an optional `--run-card <path>`:
- The run-card is treated as an **opaque JSON blob**: it is copied verbatim into the output directory (no schema assumptions).
- A best-effort **summary** (`run_id`, `backend`, `approval_trace_id`, …) is logged into `paper/run.json` (scaffold/draft-sections) or `paper/build_trace.jsonl` (consume).

All entry points also write a minimal `export_manifest.json` to help upstream orchestrators import the paper output into their own `artifacts/` layout.

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
- Backends: `--writer-backend` / `--auditor-backend` pick the model FAMILY for each role from `{claude, gemini, codex, opencode, kimi}` (defaults: writer `claude`, auditor `gemini`). The auditor is an independent pass — prefer a family OTHER than the writer's for genuine cross-family independence. Each backend auto-resolves its `<family>-cli-runner`.
- Models: `--writer-model` (default: `opus`), `--auditor-model` (default: empty → the backend CLI's own configured default model, so it tracks the latest you've set rather than pinning a version)
- Runner scripts: `--writer-runner` / `--auditor-runner` override the resolved runner path for either role; `--claude-runner` / `--gemini-runner` remain as family-specific overrides. Defaults are auto-detected under your agent skills home, e.g. `~/.claude` / `~/.codex` / `~/.config/opencode`.
- Evidence gate: `--evidence-scan=all|macros` (default `all`); if `macros`, set one or more `--evidence-macro` (e.g. `revadd`)
- Testing: `--stub-models` (no external calls), `--stub-variant=safe|unsafe` (`unsafe` should fail the evidence gate by design)

## Evidence-grounded writing via hep-mcp (recommended)

When hep-mcp is available, ground every section in ingested source material before drafting — this greatly reduces hallucinated claims and improves citation accuracy. Prereqs: a hep-mcp project with at least one paper's LaTeX source ingested, and a run with evidence artifacts (catalog + embeddings) built.

The workflow is a four-step loop:
1. **Build the evidence corpus** — `hep_run_build_writing_evidence` -> `latex_evidence_catalog.jsonl` (+ embeddings, enrichment).
2. **Build the citation mapping** — `hep_run_build_citation_mapping` -> `citekey_to_inspire_v1.json`.
3. **Draft each section against retrieved evidence** — before writing prose, `hep_project_query_evidence` (lexical) or `hep_project_query_evidence_semantic` (concept-level), then ground each claim-bearing sentence and structure it as a SectionDraft.
4. **Render + export** — `hep_render_latex` (using the citation mapping) then `hep_export_project`.

**Grounding rule:** a sentence that asserts a specific claim must carry `evidence_ids` (evidence-catalog items used) and `recids` (INSPIRE record ids), with `is_grounded: true`; ungrounded assertions are not admissible.

Full tool-call payloads, the SectionDraft JSON shape, and the end-to-end flow diagram: see `RUNBOOK.md` section 9 ("Evidence-grounded writing via hep-mcp — detailed tool-call recipes").

### Integration with existing research-writer paths

The evidence-grounded workflow complements the existing scaffold and draft-sections paths:

- **Scaffold path** (`research_writer_scaffold.sh`): Use for initial `paper/` directory creation from a research-team project. The evidence-grounded path is an alternative when working directly with hep-mcp projects.
- **Draft-sections path** (`research_writer_draft_sections.sh`): The `--run-models` writer/auditor pair can consume evidence query results as additional context. Pass evidence hits as part of the writer system prompt.
- **Consume path** (`research_writer_consume_paper_manifest.sh`): Use after `hep_export_paper_scaffold` to validate and compile the MCP-exported paper.

## Consume an MCP-exported paper scaffold (deterministic publisher)

If `hep-mcp` / `@nullius/hep-mcp` (or another agent pipeline) already produced a `paper/` directory, this skill can validate + apply deterministic hygiene + (optionally) compile it using `paper/paper_manifest.json` as the only entrypoint.

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

## Calling from an orchestrator (recommended pattern)

An orchestrator should:
1) Prepare a JSON run-card that records prompts/tools/approvals (owned by the orchestrator).
2) Call `research-writer` with `--run-card` so the paper output is self-describing and traceable.
3) Ingest `paper/export_manifest.json` and copy/snapshot the referenced files into the orchestrator’s `artifacts/` structure (owned by the orchestrator).

Example smoke (scaffold + run-card; optional compile):

```bash
cat > /tmp/run_card.json <<'JSON'
{"run_id":"SMOKE-1","workflow_id":"draft","backend":{"name":"research-writer"}}
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

1) Reads `research_notebook.md` for human narrative plus `research_contract.md` for machine-stable pointers, then builds a paper skeleton that **points back to source sections** (no hallucinated derivations).
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
- `research_notebook.md` — human derivation notebook (equations, explanations, figures).
- `research_contract.md` — machine-stable contract (capsule, pointers, headline provenance).

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
- Broader Markdown math/TOC cleanup before paper scaffolding: use the standalone `markdown-hygiene` skill.
- Evidence-gate checker (revision additions via `\revadd{...}`, or full-text via `--scan-all`): see `scripts/bin/check_latex_evidence_gate.py`.
- Result-traceability gate (delivered figures/result numbers must trace to a run): see `scripts/bin/check_result_traceability.py` and the "Result traceability" section below.
- BibTeX RevTeX 4.2 hygiene: see `scripts/bin/fix_bibtex_revtex4_2.py`.
- Cross-reference + citation integrity (`\label`/`\ref`/`\cref` resolve; no dangling refs, duplicate labels, or undefined `\cite` keys): see `scripts/bin/check_latex_xrefs.py`.
- arXiv packaging (offline: dereference figure symlinks to bytes, inline `main.bbl`, drop build cruft, fail-closed portability gate, checksum manifest): see `scripts/bin/research_writer_package_arxiv.py`.
- BibTeX fetch trace (when `--fetch-bibtex` is used): see `paper/bibtex_trace.jsonl`.

## Result traceability (results and figures traceable to runs)

Complementary to the evidence gate, not overlapping with it: the evidence gate checks that risky *claims* carry a literature/evidence anchor; this gate checks that every *result figure and annotated result number* in the manuscript is machine-traceable to the run that produced it (run id, code revision, environment fingerprint). One binds prose to sources; the other binds deliverables to runs.

Workflow position:
1. When a run produces a manuscript figure or a headline number, register it in `paper/traceability_manifest.json` **at that moment** (not at delivery time), copying `run_id`, `code_rev` (e.g. the analysis-code commit), and `env_fingerprint` (e.g. a lockfile or container digest) from the run's manifest / reproducibility capsule.
2. Before delivering a draft, run the gate over the whole paper directory:

```bash
python3 scripts/bin/check_result_traceability.py --root paper/ --report paper/result_traceability_report.md
```

Manifest shape (domain-neutral; one entry per bound figure or number):

```json
{
  "version": 1,
  "entries": [
    {
      "id": "fig:scan-summary",
      "kind": "figure",
      "artifact": "figures/scan_summary.pdf",
      "run_id": "M3-r2",
      "code_rev": "a1b2c3d",
      "env_fingerprint": "lockfile-sha256:<hex>",
      "checksum": "sha256:<hex>",
      "notes": "optional"
    },
    {
      "id": "num:fitted-width",
      "kind": "number",
      "run_id": "M3-r2",
      "code_rev": "a1b2c3d",
      "env_fingerprint": "lockfile-sha256:<hex>",
      "notes": "e.g. a fitted parameter quoted in the results section"
    }
  ]
}
```

Author-side annotation for result numbers is a LaTeX comment anchor placed adjacent to the value, whose id **is** the manifest entry id:

```latex
The fitted width is 12.3(4) units. % origin: num:fitted-width
```

Why a comment anchor rather than a wrapper macro such as `\resultnum{<id>}{<value>}`: a comment is zero-intrusion (no preamble macro definition, no change to the compiled document, nothing unfamiliar in the submitted source) and parses deterministically with the same escaped-percent rule the evidence gate already uses — no brace nesting or macro-expansion concerns. The accepted trade-off: anchor-to-value adjacency is an authoring convention the checker cannot verify; reviewers check placement, the gate checks the binding.

Gate semantics (deterministic, fail-closed — deliberately stricter than the evidence gate's warn-by-default):
- Every `\includegraphics` target must match a figure entry (path as written, extension-optional; for a dotted basename write the extension explicitly in the manuscript); a recorded checksum must match the file on disk. Artifact paths must stay inside the paper directory — absolute paths and paths with a parent-directory segment are rejected and never bind, artifacts resolve against the manuscript root (not the manifest's location), and a file that resolves outside that root (e.g. a symlink target elsewhere) fails the gate: at delivery time the paper directory must carry the real bytes.
- Every origin anchor must match a number entry; anchors binding to a figure entry are a kind mismatch.
- Every matched entry must carry non-empty `run_id`, `code_rev`, and `env_fingerprint` — all three, no partial credit.
- In `--root` mode (the delivery invocation), manifest entries that bind to nothing in the manuscript are stale and fail the gate; in partial `--tex` scans they downgrade to warnings.
- Any violation means non-zero exit plus a NOT_READY report. There is no warn-only mode. The only escape hatch for incremental adoption on legacy manuscripts is an explicit exemption list (`--exempt-id` / `--exempt-file`) keyed by manifest entry id — or, for a figure that has no manifest entry yet, by the figure path as written in the manuscript. Wildcard tokens are rejected, and structural failures (a missing or invalid manifest, an anchor with a missing or malformed id) are never exemptible.

What the gate deliberately does not do: it cannot detect result numbers that were never anchored — "every reported result value gets an anchor" is authoring discipline enforced in review. On the figure side, the figure-reproduction bundle defined in the figure-hygiene skill is the figure-side instantiation of this manifest: reuse its checksum here so the manuscript gate and the figure re-render check verify the same bytes.

## Research and manuscript guardrails

When drafting, revising, or synchronizing a manuscript:
- Do not use specialized symbols in the abstract or introduction before they have been defined. Introduce notation only where the physical or mathematical decomposition naturally requires it.
- Remove writing-process residue: assistant reasoning, internal deliberation, referee-response explanations, self-justifying prose, and workflow notes. The manuscript body should contain only scholarly argumentation.
- Minimize new notation. If a clear expression already exists, do not name it. Once notation is introduced, use it consistently.
- Use domain-standard physics terminology. Avoid engineering or vague terms such as inaccurate uses of "proxy", "coefficient", or "plotted quantity"; prefer precise terms like approximation, diagnostic quantity, observable, model component, benchmark, or reconstructed quantity when those are actually meant.
- Keep the main text focused on logic, definitions, and comparable quantities. Move long explicit formulas, full matrices, and derivational details to appendices.
- In figure and table captions, state whether each object is data, a reconstructed quantity, a model prediction, a model component, or a benchmark. Do not imply that the data separate mechanisms that only the model decomposes.
- Round table values to a number of decimal places justified by the physical precision.
- Before synchronizing edits into another paper directory, compare the local and synchronized directories so collaborator changes are not overwritten.
- After compilation, inspect undefined references/citations, overfull boxes, pagination anomalies, and orphaned headings or formulas.

## Style profile (physics writing register)

Use the writing style profile when drafting or rewriting text:
- `assets/style/style_profile.md`
- `assets/style/writing_voice_system_prompt.txt`
- Anti-hallucination guardrails (evidence gate): `assets/style/research_writer_guardrails_system_prompt.txt`
- Physics discussion logic playbook: `assets/style/physics_discussion_logic_playbook.md`
- Exemplar corpus downloader (INSPIRE → arXiv sources): `assets/style/prl_style_corpus.md` (script: `scripts/bin/fetch_prl_style_corpus.py`)
- Additional exemplar corpus (PRL hep-ph multi-author filter): `assets/style/prl_style_corpus_hep_ph_multi_author.md`
- N=10 reading-pack generator (corpus → per-paper excerpts + optional dual-model argument maps): `scripts/bin/research_writer_learn_discussion_logic.py` (writes `PROGRESS.md`/`PROGRESS.json` into `--out-dir`)
- Deterministic distiller (dual-model outputs → consensus/disagreement reports): `scripts/bin/distill_discussion_logic.py` (writes `distill/` under the chosen `--out-dir`)

Example (prepare N=10 packs; recommended masking on). The query below is an example — replace `<author1>`/`<author2>`/`<author3>` with your own exemplar authors:

```bash
python3 scripts/bin/research_writer_learn_discussion_logic.py \
  --query-url "https://inspirehep.net/literature?sort=mostrecent&size=50&page=1&q=%28a%20<author1>%20or%20a%20<author2>%20or%20a%20<author3>%29%20and%20j%20phys.rev.lett." \
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
  --out-dir "<discussion_logic_out_dir>/prl_hep-ph_example"
```

## Operational docs

- Quickstart: `README.md`
- Workflows/debugging: `RUNBOOK.md`
