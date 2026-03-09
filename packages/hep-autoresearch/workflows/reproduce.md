# reproduce — Reproduction-first

Chinese version: `workflows/reproduce.zh.md`.

## Goal

Turn “reproduce a paper’s main results” into an executable task with clear targets, explainable uncertainty, diagnosable differences, and auditable artifacts.

## Inputs

- `refkey` (target paper reading note)
- `target` (quantitative definition of the main result to reproduce)
  - examples: `"Table 1: sigma_tot (pb) at sqrt(s)=13 TeV"` or `"Fig.2 left: curve y(x)"`
- `tolerance` (allowed error; must specify abs/rel or a shape metric)

## Outputs (artifacts)

Required (see `docs/ARTIFACT_CONTRACT.md`):
- `artifacts/runs/<TAG>/reproduce/manifest.json`
- `artifacts/runs/<TAG>/reproduce/summary.json`
- `artifacts/runs/<TAG>/reproduce/analysis.json`
- `team/runs/<TAG>/...` (independent dual review reports)

Recommended:
- `artifacts/runs/<TAG>/reproduce/figures/` (comparison plots)
- `artifacts/runs/<TAG>/reproduce/logs/`

## Steps (MVP)

1) Planner generates a reproduction plan:
   - key assumptions (parameters, truncation, versions, random seeds, selections/reconstructions)
   - MVP implementation target (start with one headline number or a proxy curve diagnostic)
   - expected uncertainty and a list of plausible discrepancy sources
2) Runner executes the computation (prefer reusing `hep-calc` or existing scripts), and writes artifacts.
3) Comparator compares target vs results:
   - numerical stability (include at least one audit slice)
   - if mismatch: attribute discrepancy (params/version/method/PRNG/truncation)
4) Reviewer independently checks; if not converged, rollback to step 1/2 and fix.

## Gates (acceptance)

- SSOT artifacts exist and `analysis.json` contains at least one machine-extractable headline number.
- Uncertainty/discrepancy is explainable (even if mismatched, produce a clear reason + next minimal check).
- Independent dual review converges (or explicitly `NOT_READY` with blockers recorded in the plan).

## Extension roadmap

- v1: support multiple targets (multi-figure/multi-table) and output a “coverage matrix”.
- v2: auto-extract result candidates from LaTeX/PDF to propose targets for semi-manual selection.

