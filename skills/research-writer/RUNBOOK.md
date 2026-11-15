# research-writer — Runbook

Paths below are relative to this skill directory unless stated otherwise. Use the
installed skill's absolute script path when working inside a research project.

## Initialize and write

```bash
bash scripts/bin/research_writer_scaffold.sh \
  --project-root /path/to/project --tag M1-r1 --out /path/to/project/paper
```

The output is a blank RevTeX template, not a scientific draft. An existing output
path is refused. The scaffold does not inspect the notebook, choose source text,
fetch bibliography entries or pick figures. Read the project's notebook,
contract, literature and run artifacts, then write `main.tex` or sections it
actually includes. Keep the complete scientific narrative in the notebook.

Use the host agent's normal tools and delegation for writing and substantive
review. Give a reviewer the actual files and source evidence; read the response,
resolve the findings and change the real manuscript. Follow the existing
`claim-grounding` contract for citation-supported statements and the project's
verification workflow for calculations. Read those reports before promoting a
claim or handing it onward. A title, reference key or file-shaped string is not
evidence that a statement is supported.

## Mechanical checks

```bash
python3 scripts/bin/check_latex_xrefs.py --root /path/to/project/paper
python3 scripts/bin/check_result_traceability.py \
  --root /path/to/project/paper \
  --report /path/to/project/paper/result_traceability_report.md
```

Use the traceability check for manuscripts using project result figures/numbers.
Its input is the actual `traceability_manifest.json` described in [SKILL.md](SKILL.md).
Read the report and repair missing or stale bindings. Reviewers check unannotated
values and whether declared values match the cited result; the checker only
checks the declared bindings and metadata.

For scientific result figures/tables, use the existing `figure-hygiene` skill to
check values, units, source identity and final display. After preparing real
verification evidence and its provenance sidecar, run its checker:

```bash
python3 /path/to/figure-hygiene/scripts/bin/check_display_acceptance.py \
  --manifest /path/to/project/figs/result.provenance.json \
  --out-json /path/to/project/figs/result.display_check.json --json
```

Read the persisted verdict and its diagnostics. Do not write a placeholder
passing verdict to satisfy the schema. Preserve the same figure bytes/checksum
when moving the accepted figure into the manuscript.

RevTeX bibliography compatibility is a separate mechanical operation:

```bash
python3 scripts/bin/fix_bibtex_revtex4_2.py --bib /path/to/project/paper/references.bib
# After inspecting the proposed change, add --in-place to apply it.
```

An empty journal field is a compatibility fallback, not verified metadata. Obtain
and check metadata through existing source providers. For Markdown deliverables,
use `markdown-hygiene` and inspect the intended rendering surface. Never collapse
all doubled backslashes: `\\` can be a legitimate TeX row break.

## Build and inspect

For a normal paper directory, use its actual entry point:

```bash
cd /path/to/project/paper
latexmk -pdf main.tex
```

Read build warnings and inspect the current PDF, especially equations, figure and
table labels, citations and page breaks. Missing tools or failed compilation are
incomplete PDF delivery, regardless of an older PDF already on disk.

An external producer may instead supply `paper_manifest.json`. Preserve that
interface and pass it to the existing consumer:

```bash
bash scripts/bin/research_writer_consume_paper_manifest.sh \
  --paper-manifest /path/to/paper/paper_manifest.json --compile
```

The consumer validates the manifest's files, applies bibliography hygiene and
records its operations in `build_trace.jsonl` and `export_manifest.json`.
`--compile` is a real build request: absence of `latexmk` or a failed build returns
failure and does not advertise an old PDF as current output. Without that flag,
validation alone does not certify a PDF. Scientific review and display checks
remain explicit agent work.

The build uses an isolated output directory. Its current `.fls` recorder and
existing input checksums populate `input_hashes` / `output_hashes` in the export
manifest. `--writer-export` rechecks these bindings before copying. Rebuild after
changing a bound source/output, and rebuild older compiled receipts without
bindings before presenting them as a current build. Use explicit inclusion for
historical files whose status is intentionally retained.

For a submission bundle, use `research_writer_package_arxiv.py --help` and its
existing packaging contract. Recheck the packaged sources/dependencies; packaging
is not a review of scientific claims.

## Export and deliver

Read the current `export_manifest.json`, including its status and referenced
paths. Use the existing `research-team` export command with `--writer-export` to
consume it and explicit `--include` entries for additional required manuscript,
source and review files. See that skill's runbook for the full export command.
The scaffold's initial manifest describes `blank_scaffold` / `not_run`; a later
direct build must be included explicitly, not inferred from that status.

Open the exported readable result and verify that sources, figures and required
evidence travel with it. Give the user the deliverable links and material open
issues. Record delivery status in the plan/index; the notebook keeps scientific
conclusions and useful result links, not transport logs. A manifest, build log or
draft in an unreferenced directory is not a replacement for the requested result.

## Optional exemplar reading

Acquire and read examples only when it helps the current scientific writing task.
The helpers below preserve source acquisition and resumable reading work. They
do not decide the manuscript's argument or automatically establish consensus.

### Acquire source papers (INSPIRE → arXiv sources)

Use this to collect arXiv LaTeX sources from exemplar papers so you can extract **general physics discussion logic** (argument flow, diagnostics, uncertainty narration). This is not about superficial PRL formatting.

Example INSPIRE query — replace `<author1>`/`<author2>`/`<author3>` with your own exemplar authors.

```bash
python3 scripts/bin/fetch_prl_style_corpus.py \
  --query-url "https://inspirehep.net/literature?sort=mostrecent&size=50&page=1&q=%28a%20<author1>%20or%20a%20<author2>%20or%20a%20<author3>%29%20and%20j%20phys.rev.lett.&ui-citation-summary=true" \
  --max-records 50 \
  --resume \
  --out-dir /tmp/prl_style_corpus
```

### Prepare reading packs

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

### Optional model analysis (Claude + Gemini example)

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

### Repair incomplete model analysis

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
- Use `PROGRESS.md` to find missing source reads or outputs. A completed model batch does not establish agreement or scientific validity.

Offline testing helper:
- For pipeline testing without calling any external LLM CLIs, use `--stub-models` (writes deterministic stub `claude.md`/`gemini.md`).

Prereqs for `--run-models`:
- `claude` and `gemini` CLIs available in `PATH`
- Runner skills installed under your agent skills home (e.g. `~/.claude`, `~/.codex`, `~/.config/opencode`, `~/.kimi-code`):
  - `claude-cli-runner`
  - `gemini-cli-runner`


### Synthesize from the sources

Read original passages behind the packs and optional argument maps. Compare the
reasoning, assumptions and counterexamples across papers; preserve source
locators and qualifications when forming a reusable lesson. Matching vocabulary
or two models mentioning the same category does not establish agreement. Treat
`PROGRESS.md` and model files as analysis inputs, never scientific acceptance.

Use [the discussion guidance](assets/style/physics_discussion_logic_playbook.md)
for optional questions to ask of the source, not a required paragraph template.
