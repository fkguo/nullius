# research-writer — Runbook

## Common workflows

### 1) Scaffold a paper from a research-team project

```bash
bash scripts/bin/research_writer_scaffold.sh --project-root /path/to/project --tag M1-r1 --out paper/
```

### 1b) Consume an MCP-exported `paper/` scaffold (deterministic publisher)

If a separate agent / `hep-mcp` / `@nullius/hep-mcp` already exported a `paper/` directory, `research-writer` can validate + apply deterministic hygiene + (optionally) compile it using a single entrypoint:

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

### 4d) Result-traceability gate (before delivering a draft)

Every `\includegraphics` figure and every annotated result number must trace to the run that produced it via `paper/traceability_manifest.json` (see the "Result traceability" section in `SKILL.md` for the manifest shape and the `% origin: <id>` comment anchor):

```bash
python3 scripts/bin/check_result_traceability.py --root paper --report paper/result_traceability_report.md
```

Fail-closed: any violation exits non-zero with a NOT_READY report (no warn-only mode). For incremental adoption on a legacy manuscript, exempt specific manifest entry ids — or, for a figure with no manifest entry yet, the figure path as written — one per line; wildcards are rejected:

```bash
python3 scripts/bin/check_result_traceability.py --root paper --exempt-file paper/traceability_exemptions.txt
```

### 5) Optional: build an exemplar corpus for deep reading (INSPIRE → arXiv sources)

Use this to collect arXiv LaTeX sources from exemplar papers so you can extract **general physics discussion logic** (argument flow, diagnostics, uncertainty narration). This is not about superficial PRL formatting.

Example INSPIRE query — replace `<author1>`/`<author2>`/`<author3>` with your own exemplar authors.

```bash
python3 scripts/bin/fetch_prl_style_corpus.py \
  --query-url "https://inspirehep.net/literature?sort=mostrecent&size=50&page=1&q=%28a%20<author1>%20or%20a%20<author2>%20or%20a%20<author3>%29%20and%20j%20phys.rev.lett.&ui-citation-summary=true" \
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
  --query-url "https://inspirehep.net/literature?sort=mostrecent&size=50&page=1&q=%28a%20<author1>%20or%20a%20<author2>%20or%20a%20<author3>%29%20and%20j%20phys.rev.lett.&ui-citation-summary=true" \
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
- Runner skills installed under your agent skills home (e.g. `~/.claude`, `~/.codex`, `~/.config/opencode`):
  - `claude-cli-runner`
  - `gemini-cli-runner`

### 8) Distill discussion logic (mind maps → playbook)

Once you have a run directory with dual-model outputs under `packs/*/{claude,gemini}.md`, generate deterministic consensus/disagreement reports:

```bash
python3 scripts/bin/distill_discussion_logic.py \
  --out-dir "<discussion_logic_out_dir>/prl_hep-ph_example"
```

Outputs are written under `<out-dir>/distill/`:
- `CONSENSUS.md`
- `DISAGREEMENTS.md`
- `STATS.json`

Then (agent/human step): manually merge selected high-confidence patterns into:
- `assets/style/physics_discussion_logic_playbook.md`

### 9) Evidence-grounded writing via hep-mcp (detailed tool-call recipes)

Full payloads for the four-step evidence-grounded workflow summarized in `SKILL.md`.
Prereqs: a hep-mcp project with at least one paper's LaTeX source ingested, and a run
with evidence artifacts (catalog + embeddings) built.

**Step 1 — Build evidence corpus** (produces `latex_evidence_catalog.jsonl`, `latex_evidence_embeddings.jsonl`, `latex_evidence_enrichment.jsonl`):

```
hep_run_build_writing_evidence({
  run_id: "<run_id>",
  latex_sources: [
    { identifier: "<arXiv_id_or_DOI>", include_inline_math: true, include_cross_refs: false }
  ],
  latex_types: ["paragraph", "equation", "figure", "table", "citation_context"],
  max_evidence_items: 2000,
  embedding_dim: 256,
  continue_on_error: false
})
```

**Step 2 — Build citation mapping** (produces `citekey_to_inspire_v1.json`, used later by `hep_render_latex`):

```
hep_run_build_citation_mapping({
  run_id: "<run_id>",
  identifier: "<arXiv_id_or_DOI>",
  allowed_citations_primary: [],
  include_mapped_references: true
})
```

**Step 3 — Section-by-section drafting with evidence retrieval.** For each outline section, before writing prose, query evidence (lexical or, for concept-level queries, semantic):

```
hep_project_query_evidence({
  project_id: "<project_id>",
  query: "<section topic keywords>",
  mode: "lexical",         // or "semantic" (requires run_id)
  run_id: "<run_id>",      // required for semantic mode
  types: ["paragraph", "equation", "citation_context"],
  limit: 10
})
```

```
hep_project_query_evidence_semantic({
  run_id: "<run_id>",
  project_id: "<project_id>",
  query: "<conceptual description of section content>",
  types: ["paragraph", "equation"],
  limit: 10
})
```

Ground each claim-bearing sentence with `evidence_ids` (catalog items used), `recids` (INSPIRE ids), and `is_grounded: true`, structured as a SectionDraft:

```json
{
  "version": 1,
  "title": "Section Title",
  "paragraphs": [
    {
      "sentences": [
        {
          "sentence": "Plain text sentence.",
          "sentence_latex": "LaTeX-formatted sentence with $\\alpha_s$.",
          "type": "fact",
          "is_grounded": true,
          "claim_ids": [],
          "evidence_ids": ["ev_abc123"],
          "recids": ["1234567"]
        }
      ]
    }
  ]
}
```

**Step 4 — Render + export.** Render the structured draft to LaTeX with citations, then export the research pack:

```
hep_render_latex({
  run_id: "<run_id>",
  draft: <ReportDraft>,
  cite_mapping: <citekey_to_inspire_v1.json contents>,
  latex_artifact_name: "rendered_latex.tex",
  section_output_artifact_name: "rendered_section_output.json"
})
```

```
hep_export_project({
  run_id: "<run_id>",
  rendered_latex_artifact_name: "rendered_latex.tex",
  include_evidence_digests: true,
  _confirm: true
})
```

`hep_export_project` produces `master.bib`, `report.tex`, `report.md`, `research_pack.zip`, and NotebookLM-friendly chunks.

End-to-end flow:

```
evidence catalog ──→ evidence query (per section) ──→ grounded draft ──→ render LaTeX ──→ export
      ↑                                                     │
      │                                                     ↓
  source papers                                    citation mapping
  (arXiv LaTeX)                                   (INSPIRE recids)
```

## Debugging

### “No artifacts found for tag”

- Ensure the `--tag` matches a folder under `artifacts/runs/<TAG>/` or files like `artifacts/<TAG>_manifest.json`.
- If your project uses a different layout, run scaffold with `--verbose` and inspect the printed search paths.

### “latexmk not found”

- This is expected on minimal environments. Smoke tests must report `SKIPPED: latexmk not found` and still pass.

### Network/DNS failures during BibTeX fetch

- The scaffold must degrade gracefully: keep stable links (INSPIRE/arXiv/DOI) as placeholders and allow later backfill.
