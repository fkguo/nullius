# research-writer (Codex skill)

`research-writer` scaffolds an arXiv-ready paper draft from a `research-team` project:
- RevTeX4-2, `12pt`, `onecolumn`
- deterministic provenance table wiring
- BibTeX hygiene (RevTeX4-2)
- deterministic Markdown math escape checks (e.g. `\\Delta` → `\Delta`)

See also: `README.zh.md` (Chinese).

## Prereqs

- `bash`, `python3`
- Optional (compile): TeX toolchain + `latexmk`
- Optional (LLM drafting via `--run-models`): local `claude` + `gemini` CLIs (and their runner skills)
- Optional (BibTeX fetch via `--fetch-bibtex`): network access (INSPIRE/DOI)

## One-shot scaffold

```bash
bash scripts/bin/research_writer_scaffold.sh \
  --project-root /path/to/research-team-project \
  --tag M1-r1 \
  --out paper/
```

Optional: pass a run-card (opaque JSON) for upstream traceability; this will be copied into `paper/` and referenced by `paper/run.json` + `paper/export_manifest.json`:

```bash
bash scripts/bin/research_writer_scaffold.sh \
  --project-root /path/to/research-team-project \
  --tag M1-r1 \
  --out paper/ \
  --run-card /path/to/run_card.json
```

## Optional: draft sections (opt-in LLM calls)

Produces a single human-readable `*_final.tex` per section (writer → auditor), plus a diff and trace logs. Does not modify `paper/main.tex`.

```bash
bash scripts/bin/research_writer_draft_sections.sh \
  --project-root /path/to/research-team-project \
  --paper-dir paper/ \
  --tag M1-r1 \
  --run-id D1 \
  --all \
  --run-models
```

Then (optional build):

```bash
cd paper && latexmk -pdf main.tex
```

## Optional: consume an MCP-exported `paper/` scaffold (deterministic)

If a separate pipeline exported a `paper/` directory with `paper/paper_manifest.json`:

```bash
bash scripts/bin/research_writer_consume_paper_manifest.sh --compile
```
