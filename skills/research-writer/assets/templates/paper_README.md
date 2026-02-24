# Paper scaffold (research-writer)

This folder was generated from a `research-team` project.

## Build

```bash
latexmk -pdf main.tex
```

## Provenance

- All quoted numbers should have a provenance pointer: `artifact path + key`.
- Any external claim used in core reasoning must be validated or labeled `UNVERIFIED` with a validation plan + kill criterion.
- Discussion logic: bottom line → mechanism → diagnostics → comparison → limitations/outlook (see `research-writer/assets/style/physics_discussion_logic_playbook.md`).
- Anti-hallucination: do not add provenance/uncertainty details without evidence anchors. If you use revision macros, you can lint additions via `python3 research-writer/scripts/bin/check_latex_evidence_gate.py --root . --fail`.

## Scaffold level

- M1: minimal compilable skeleton (section TODOs remain).
- M2: populate TODOs from `Draft_Derivation.md` and `artifacts/` manifests/summaries.
