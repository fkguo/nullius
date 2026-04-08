# research-writer — Runbook

## Common workflows

### 1) Scaffold a paper from a research-team project

```bash
bash scripts/bin/research_writer_scaffold.sh --project-root /path/to/project --tag M1-r1 --out paper/
```

### 1b) Consume an MCP-exported `paper/` scaffold (deterministic publisher)

If a separate agent / `hep-mcp` / `@autoresearch/hep-mcp` already exported a `paper/` directory, `research-writer` can validate + apply deterministic hygiene + (optionally) compile it using a single entrypoint:

- Manifest entrypoint: `paper/paper_manifest.json`
- Audit log: `paper/build_trace.jsonl`

```bash
# From the project root (default manifest path paper/paper_manifest.json):
bash scripts/bin/research_writer_consume_paper_manifest.sh --compile

# Or explicitly:
bash scripts/bin/research_writer_consume_paper_manifest.sh \
  --paper-manifest /path/to/paper/paper_manifest.json \
  --compile
```

What validate enforces (fail-fast):
- `schemaVersion` is supported
- `main.tex` / `sections/` / bibs / `figures/` paths exist
- no `.tex` contains `hep://`
- no citekey conflicts between `references_generated.bib` and `references_manual.bib`

What hygiene applies:
- creates an empty `references_manual.bib` if missing
- ensures `main.tex` references **both** generated and manual bib layers

### 2) Compile (if TeX toolchain exists)

```bash
cd paper
latexmk -pdf main.tex
```

### 3) BibTeX hygiene (RevTeX4-2)

If BibTeX fails on `@article` entries without a `journal` field:

```bash
python3 scripts/bin/fix_bibtex_revtex4_2.py --bib paper/references.bib --in-place
```

### 4) Markdown double-backslash math check (and fix)

Check (warn-only by default):

```bash
bash scripts/bin/check_md_double_backslash.sh --root paper
```

Fix (in-place):

```bash
python3 scripts/bin/fix_md_double_backslash_math.py --root paper --in-place
```

### 4b) LaTeX evidence gate for revision additions (anti-hallucination)

If your project uses revision macros (e.g., `\\revadd{...}`), you can lint risky new additions that mention external data provenance / uncertainties / error models **without** an evidence anchor:

```bash
python3 scripts/bin/check_latex_evidence_gate.py --root paper --fail
```

If you want to lint a newly drafted `.tex` file that does not use revision macros, use `--scan-all` (paragraph scan):

```bash
python3 scripts/bin/check_latex_evidence_gate.py --tex paper/sections/introduction.tex --scan-all --fail
```

Evidence anchors accepted by the checker:
- `Table/Fig/Eq/Sec/...` **and** `\\cite{...}` in the same added block, or
- a project-local evidence file path (e.g., `paper_audit/data/...`, `artifacts/...`).

Recommended prompt guardrails for the agent:
- `assets/style/research_writer_guardrails_system_prompt.txt`

### 4c) Draft paper sections (opt-in; writer → auditor)

This helper is designed for **human usability**: it produces one primary `*_final.tex` per section while preserving the writer draft and a diff for auditability. It does **not** modify `paper/main.tex`.

```bash
bash scripts/bin/research_writer_draft_sections.sh \
  --project-root /path/to/project \
  --paper-dir paper/ \
  --tag M1-r1 \
  --run-id D1 \
  --all \
  --run-models
```

Outputs land under `paper/drafts/<run-id>/` (plus `run.json` + `trace.jsonl`).

### 5) Optional: build an exemplar corpus for deep reading (INSPIRE → arXiv sources)

Use this to collect arXiv LaTeX sources from exemplar papers so you can extract **general physics discussion logic** (argument flow, diagnostics, uncertainty narration). This is not about superficial PRL formatting.

```bash
python3 scripts/bin/fetch_prl_style_corpus.py \
  --query-url "https://inspirehep.net/literature?sort=mostrecent&size=50&page=1&q=%28a%20f%20k%20guo%20or%20a%20u%20g%20meissner%20or%20a%20m%20hoferichter%29%20and%20j%20phys.rev.lett.&ui-citation-summary=true" \
  --max-records 50 \
  --resume \
  --out-dir /tmp/prl_style_corpus
```

### 6) Generate N=10 reading packs (corpus → excerpts)

This produces per-paper packs (Abstract/Intro/Conclusions + semantically curated diagnostics paragraphs, with deterministic fallback candidates) to enable clean-room, auditable extraction of discussion logic.

```bash
python3 scripts/bin/research_writer_learn_discussion_logic.py \
  --corpus-dir /tmp/prl_style_corpus \
  --n 10 \
  --resume \
  --out-dir /tmp/research_writer_discussion_logic \
  --mask-math \
  --mask-cites
```

### 7) Optional: run a dual-model pass (Claude + Gemini)

```bash
python3 scripts/bin/research_writer_learn_discussion_logic.py \
  --query-url "https://inspirehep.net/literature?sort=mostrecent&size=50&page=1&q=%28a%20f%20k%20guo%20or%20a%20u%20g%20meissner%20or%20a%20m%20hoferichter%29%20and%20j%20phys.rev.lett.&ui-citation-summary=true" \
  --fetch \
  --fetch-n 50 \
  --n 10 \
  --resume \
  --out-dir "<discussion_logic_out_dir>" \
  --mask-math \
  --mask-cites \
  --run-models
```

Repeat in batches (e.g., 5× for 50 packs). Track progress in `<out-dir>/PROGRESS.md` (updated each run).

Batch size heuristic (`--n`):
- Default `--n 10` is a good balance for rate limits and resumability.
- Use `--n 5` if you expect flaky network/LLM availability (minimize redo on failures).
- Use `--n 20` only if your network and model calls are stable and you want fewer batch invocations.

### 7b) Repair missing model outputs (recommended for flaky networks)

If some packs exist but one model output is missing, rerun in repair mode:

```bash
python3 scripts/bin/research_writer_learn_discussion_logic.py \
  --corpus-dir "<discussion_logic_out_dir>/corpus" \
  --out-dir "<discussion_logic_out_dir>" \
  --mode repair \
  --n 10 \
  --resume \
  --models gemini \
  --mask-math \
  --mask-cites
```

Progress tracking (recommended):
- Each run writes/updates `PROGRESS.md` and `PROGRESS.json` in the chosen `--out-dir`.
- Repeat `--mode new --n 10 --resume --run-models` until `PROGRESS.md` shows your target completeness (e.g. `Dual-model complete: 50/50`).

Offline testing helper:
- For pipeline testing without calling any external LLM CLIs, use `--stub-models` (writes deterministic stub `claude.md`/`gemini.md`).

Prereqs for `--run-models`:
- `claude` and `gemini` CLIs available in `PATH`
- Runner skills installed under `$CODEX_HOME/skills/`:
  - `claude-cli-runner`
  - `gemini-cli-runner`

### 8) Distill discussion logic (mind maps → playbook)

Once you have a run directory with dual-model outputs under `packs/*/{claude,gemini}.md`, generate deterministic consensus/disagreement reports:

```bash
python3 scripts/bin/distill_discussion_logic.py \
  --out-dir "<discussion_logic_out_dir>/prl_hep-ph_xdj_hxz_fy_jz_mpospelov"
```

Outputs are written under `<out-dir>/distill/`:
- `CONSENSUS.md`
- `DISAGREEMENTS.md`
- `STATS.json`

Then (agent/human step): manually merge selected high-confidence patterns into:
- `assets/style/physics_discussion_logic_playbook.md`

## Debugging

### “No artifacts found for tag”

- Ensure the `--tag` matches a folder under `artifacts/runs/<TAG>/` or files like `artifacts/<TAG>_manifest.json`.
- If your project uses a different layout, run scaffold with `--verbose` and inspect the printed search paths.

### “latexmk not found”

- This is expected on minimal environments. Smoke tests must report `SKIPPED: latexmk not found` and still pass.

### Network/DNS failures during BibTeX fetch

- The scaffold must degrade gracefully: keep stable links (INSPIRE/arXiv/DOI) as placeholders and allow later backfill.
