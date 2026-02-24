# W3b — Review → revise loop (LaTeX)

Chinese version: `workflows/W3_revision.zh.md`.

## Goal

Run a safe, auditable “review → revise → re-review” loop over a LaTeX manuscript, with:
- diffs,
- compile gates,
- citation/evidence gates,
- independent reviewer convergence.

## Inputs

- a LaTeX project (`paper/` or user-provided path)
- a reviewer report (or the ability to generate one)

## Outputs (artifacts)

Required:
- diffs for every edit batch
- compile logs
- `manifest/summary/analysis` for each revision iteration

## Gates (acceptance)

- A4 approval gate must trigger before editing manuscripts (unless explicitly full-auto).
- Manuscript must compile after each revision.
- Independent review must converge, or blockers must be recorded.

## Extension roadmap

- v1: structured reviewer report schema and automatic mapping into a revision plan.
- v2: multi-reviewer quorum and stronger injection resistance.

