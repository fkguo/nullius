---
name: research-writer
description: Write and review a scientific manuscript from the project's research notebook, sources and results using the active host agent. Includes blank RevTeX scaffolding, external paper-manifest interoperability, bibliography/cross-reference checks, result traceability and delivery preparation. Use for manuscript drafting or synthesis; keep the complete research notebook as the human scientific record.
---

# Research Writer

The host agent owns scientific reading, selection, argument, writing and revision.
Use its normal tools and delegation in the current harness. Read the actual
research, write the manuscript files that will be built, and reconcile review
findings before handing the result to the user.

`research_notebook.md` is the complete human research notebook: derivations,
reasoning, experiments, failures, interpretation and open questions belong there.
`research_contract.md` holds stable project pointers and acceptance conditions.
A manuscript synthesizes the research for a particular audience; it does not
replace the notebook or turn it into an index of artifacts.

## Main workflow

1. **Establish the writing task.** Read the user's requested deliverable, current
   notebook, contract, relevant knowledge-base notes and source/run artifacts.
   Read enough of each dependency to assess the intended claim. Headings,
   abstracts and an automatically selected excerpt are discovery aids, not the
   writing context. Choose structure, level of detail and journal conventions
   from this research task.
2. **Write the real manuscript.** Use an existing paper directory when present;
   compare versions before editing. Otherwise initialize the blank template
   below, or use a suitable existing project template. Write directly to
   `main.tex` and/or files included through `\input` or `\include`. Check that
   revised sections actually belong to the build. Save a separate draft or diff
   only when it helps review; it must not silently become a disconnected final.
3. **Ground the scientific content.** Use the existing `claim-grounding` procedure
   for citation-backed statements: read the relevant source, bind its identity,
   record its supporting span and scope, and read the resulting verdicts.
   Correct or qualify unsupported and conflicting claims. Citation existence or
   a path written in prose does not establish support. For calculated results,
   read the derivation/run evidence and perform the applicable verification from
   `research-integrity`, `numerical-reliability-gate` or the project workflow.
   Distinguish assumptions, literature statements and independently checked
   results; do not manufacture verification details to fill a template.
4. **Review and revise.** For a substantive manuscript, follow
   [referee-review](../referee-review/SKILL.md) and delegate the scientific
   assessment to an independent host agent or the existing
   [review-swarm](../review-swarm/SKILL.md) launcher. Give the
   reviewer the actual manuscript, research question, relevant source passages
   and artifact paths with access to the files. Ask for counterexamples,
   unsupported steps and missing checks. A different provider may help but is
   not a substitute for independent examination. Read the findings, perform the
   necessary checks, edit the real files and re-review the changed claims. When
   an independent reviewer is unavailable, disclose that limitation rather than
   inventing a passed review. A packet's headings, a report schema or a
   mechanical check cannot issue the scientific assessment. Do not require a fixed provider pair, section
   count or number of review rounds.
5. **Check the current deliverable.** Run the applicable checks below and read
   their outputs. Mechanical success checks file integrity and declared
   bindings; the agent still checks scientific adequacy and coverage. For a PDF
   deliverable, compile the current source and inspect the rendered PDF,
   including equations, captions, tables and references. A failed or unavailable
   build remains incomplete unless the user requested source only.
6. **Complete the handoff.** Read the current `export_manifest.json`, verify which
   files and statuses it actually describes, and include those files plus any
   required dependencies in the project's export. Use the existing
   `research-team` export workflow (`--writer-export` / explicit `--include`),
   then open the exported manuscript and check the copied dependencies. Include
   review/verification evidence needed for the claimed status. Link the readable
   result and source bundle to the user and state material open issues. Record
   handoff status in `research_plan.md` / `project_index.md`; keep scientific
   conclusions and useful result links in the notebook, without tool-delivery
   logs. Creating a manifest alone does not deliver files.

## Blank format template

Run commands with paths relative to this skill directory (or its installed copy).
`bash` and Python 3 are required; TeX and `latexmk` are needed for a PDF build.

```bash
bash scripts/bin/research_writer_scaffold.sh \
  --project-root /path/to/research-project \
  --tag M1-r1 \
  --out /path/to/research-project/paper
```

This initializes `main.tex`, an empty `references.bib`, `figures/`, `latexmkrc`,
`README.md`, `run.json` and `export_manifest.json`. It reads no notebook passages,
chooses no equations/figures/results and invokes no model or network provider.
The RevTeX 4.2 template is a format starting point, not an arXiv-ready paper.
Existing output paths are refused so a prior manuscript cannot be erased.
`--title` and `--authors` accept plain text; edit TeX for formulas and affiliations.
Optional `--run-card <path>` copies valid opaque JSON byte-for-byte, recording its
path and hash. The initial manifest declares `blank_scaffold` and `not_run`.

Add bibliography records through the existing source providers after checking
the cited work. Keep unresolved metadata explicit; do not invent it. For HEP,
`inspire_paper_source` / `arxiv_paper_source` retrieve content and
`inspire_resolve_citekey` supplies metadata. Other domains use their available
source providers. See [RUNBOOK.md](RUNBOOK.md) for operational examples.

## Existing manuscript interoperability

An external producer can supply `paper_manifest.json` describing its paper.
This remains a supported input contract, separate from the scaffold's output
`export_manifest.json`. Do not rename one manifest to impersonate the other.

```bash
bash scripts/bin/research_writer_consume_paper_manifest.sh \
  --paper-manifest /path/to/paper/paper_manifest.json \
  --compile
```

The consumer validates the manifest/files, applies its documented bibliography
hygiene and optionally compiles, recording `build_trace.jsonl` and a current
`export_manifest.json`. Without `--compile`, it does not certify a PDF. With
`--compile`, missing `latexmk` or a failed build is a failure; a pre-existing PDF
is not evidence of current compilation. Read the exit status and manifest before
exporting. This mechanical consumer does not execute scientific review for you.

A successful compilation binds the current source and output bytes through
`input_hashes` / `output_hashes` in that same export manifest. The current TeX
`.fls` recorder adds actual project-local inputs to the binding. The exporter
rechecks these hashes; changes to a bound source or output require a new build.
An older compiled receipt without these bindings must be rebuilt before it can
serve as current compilation evidence. Historical files remain available through
explicit inclusion with their historical status stated.

For a paper without that external manifest, build its actual entry point with
`latexmk -pdf main.tex` inside the paper directory. Explicitly include the current
PDF and source dependencies at export; the initial scaffold manifest still
records initialization, not that later build.

## Checks and their consumers

| Check | When it applies | Action after the check |
| --- | --- | --- |
| `claim-grounding` | Literature-backed or attribution claims | Read the report's source identities, supporting spans and verdicts; revise unsupported claims and carry the report into the research handoff. |
| Scientific/result review | Substantive claims, derivations or computed results | Execute the required checks, reconcile findings in the actual paper and keep evidence for the conclusion. |
| `check_latex_xrefs.py --root paper` | LaTeX manuscripts | Fix dangling references, duplicate labels and undefined citation keys. |
| `check_result_traceability.py --root paper --report paper/result_traceability_report.md` | A paper using project result figures or numbers | Read the report; correct missing/stale bindings and changed bytes. Review result coverage separately. |
| `figure-hygiene` display acceptance | Scientific result figures/tables | Verify the values, units and final rendered surfaces; run its acceptance checker, read the saved result and reconcile failures before inclusion. |
| `markdown-hygiene` | Human-readable Markdown notes/deliverables | Check the intended rendering surface and inspect proposed edits. Preserve legitimate TeX line breaks. |
| `fix_bibtex_revtex4_2.py --bib paper/references.bib` | RevTeX bibliography compatibility | Inspect proposed changes; use `--in-place` when appropriate. This does not validate metadata or claims. |
| TeX build and visual inspection | A requested PDF | Read the log and inspect the current PDF; fix material rendering problems. |
| `research_writer_package_arxiv.py` | A requested portable submission bundle | Use its documented CLI, inspect the packaged files and manifest; retain the review evidence separately as appropriate. |

Do not create placeholder `pass` reports or marks to make these steps green.
Report a check as not applicable with a concrete reason when the manuscript has
no corresponding claims or displays. A notebook-only stage does not require a
paper, arXiv package or publication-specific checks.

## Result traceability

When a result enters the manuscript, add its real producing run to
`paper/traceability_manifest.json`, including `run_id`, `code_rev` and
`env_fingerprint`. Copy these from the run/reproducibility capsule. Copy figures
as real bytes inside the paper directory and bind their checksums to the same
files checked by `figure-hygiene`.

```json
{
  "version": 1,
  "entries": [
    {
      "id": "fig:scan-summary",
      "kind": "figure",
      "artifact": "figures/scan_summary.pdf",
      "run_id": "M3-r2",
      "code_rev": "<analysis commit>",
      "env_fingerprint": "<lockfile or container digest>",
      "checksum": "sha256:<actual file digest>"
    },
    {
      "id": "num:fitted-width",
      "kind": "number",
      "run_id": "M3-r2",
      "code_rev": "<analysis commit>",
      "env_fingerprint": "<lockfile or container digest>",
      "notes": "<result artifact path and value/key locator>"
    }
  ]
}
```

Place the number entry's id adjacent to its use in a LaTeX comment:

```latex
The fitted width is 12.3(4) units. % origin: num:fitted-width
```

Run the whole-paper check before handoff:

```bash
python3 scripts/bin/check_result_traceability.py \
  --root paper --report paper/result_traceability_report.md
```

The checker validates declared figure/number bindings and required run metadata;
it checks a figure's checksum when supplied. It rejects paths outside the paper,
missing bindings and, in whole-root mode, unused manifest entries. Non-zero exit
means `NOT_READY`. For legacy adoption, explicit individual exemptions exist;
record their scientific impact and do not use wildcard exemptions.

The checker cannot discover all unannotated result values or establish that an
adjacent number equals the claimed result. The writing agent and reviewer must
check that coverage and compare values with their source artifacts. Empty or
syntactically valid manifests do not supply missing scientific evidence.

## Writing guidance and optional source reading

Keep notation defined, assumptions visible and comparisons commensurate. Connect
equations to their interpretation; distinguish measurements, reconstructed
quantities and model components. Use precision justified by the calculation and
uncertainty. Remove assistant/process residue from the manuscript body, while
preserving meaningful reasoning and unresolved questions in the research notes.

For physics writing, consult [the style profile](assets/style/style_profile.md)
and [discussion guidance](assets/style/physics_discussion_logic_playbook.md) as
optional aids. Their examples are not a compulsory section order or scientific
acceptance rules. For tracked referee revisions use the sibling `paper-reviser`.

The existing corpus downloader and reading-pack generator remain available for
source acquisition and bounded reading work:

```bash
python3 scripts/bin/research_writer_learn_discussion_logic.py \
  --corpus-dir /path/to/exemplar-corpus \
  --out-dir /path/to/reading-packs --n 10 --resume
```

Read the original passages behind a pack before applying a lesson. The optional
model-generated argument maps are analysis inputs, not votes or automatic
consensus. Compare the underlying arguments and counterexamples yourself;
frequency or matching vocabulary does not establish agreement. Preserve source
locators and limitations in any synthesis. Source fetching, shared semantic
curation and general model runners retain their existing roles.

## Operational docs

- [Quickstart](README.md)
- [Runbook](RUNBOOK.md)
- [Chinese guide](SKILL.zh.md) (`SKILL.md` defines the contract)
