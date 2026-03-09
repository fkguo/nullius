# Draft writing (Draft_Derivation/KB → compilable draft)

Chinese version: `workflows/draft.zh.md`.

## Goal

Before entering `revision` (review → revise → re-review), produce a **compilable paper draft** from an existing `Draft_Derivation.md` + `knowledge_base/` (and optionally `artifacts/`), in a reproducible and auditable way.

## Inputs

Required:
- `Draft_Derivation.md`
- `knowledge_base/`

Recommended:
- `artifacts/` (required if the draft includes results/figures/numbers)

## Outputs (artifacts)

Required:
- a compilable LaTeX scaffold under `paper/` (or a user-specified LaTeX repo)
- compile logs and diffs where applicable

Recommended:
- `artifacts/runs/<TAG>/draft/manifest.json|summary.json|analysis.json`

## Steps (MVP)

1) Extract structure from `Draft_Derivation.md` (sections, references, key claims).
2) Generate a minimal RevTeX scaffold (`paper/`) with TODO markers.
3) Populate citations and evidence pointers (artifact pointers for any quoted numbers).
4) Compile gate: `latexmk` must succeed (no silent failures).
5) Write artifacts and a short derived report.

## Gates (acceptance)

- Draft compiles.
- Any quoted number has an artifact pointer.
- Citation hygiene gate passes (no broken keys; no missing BibTeX where required).

## Extension roadmap

- v1: richer extraction (tables/figures) and deterministic formatting passes.
- v2: optional “research-writer refinement” loop to improve readability while preserving evidence pointers.

