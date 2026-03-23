# Artifact contract

Every meaningful workflow step writes auditable artifacts to disk.
The default root is `artifacts/runs/<TAG>/`.

## Minimal outputs

- `manifest.json` records command, parameters, versions, and produced files.
- `summary.json` records derived statistics, definitions, or aggregation rules.
- `analysis.json` records headline results and the pointers needed to justify them.

## Working rule

- Reported numbers should be traceable to on-disk files, not only to prose.
- Human-readable notes may summarize results, but JSON or equivalent machine-readable artifacts remain the source of truth.
- If a workflow cannot yet produce the full trio, record the gap explicitly in `research_plan.md` and `research_contract.md`.
