# computation — Generic compute DAG (run_card v2)

Chinese version: `workflows/computation.zh.md`.

## Goal

Run a project-provided, declarative, auditable computation pipeline:
- strict `run_card v2` validation
- serial DAG execution (topological order)
- deterministic artifacts (manifest/summary/analysis/report)
- resumable execution with fail-closed semantics

computation is intentionally **domain-agnostic**: any physics/domain logic must live in the project plugin (e.g. `examples/<project>/scripts/*`) and be invoked via shell backends.

## Inputs

Required:
- `run_card` (run_card v2 JSON), referenced by CLI `--run-card <path>`

Optional:
- `--param key=value` overrides (type-coerced by run_card v2 parameter specs)
- `--project-dir <path>` (otherwise inferred from `<project_dir>/run_cards/<card>.json`)
- `--resume` (resume from `artifacts/runs/<run_id>/computation/` when run-card matches)

## Outputs (artifacts)

Required (see `docs/ARTIFACT_CONTRACT.md`):
- `artifacts/runs/<RUN_ID>/computation/manifest.json`
- `artifacts/runs/<RUN_ID>/computation/summary.json`
- `artifacts/runs/<RUN_ID>/computation/analysis.json`
- `artifacts/runs/<RUN_ID>/computation/report.md`
- `artifacts/runs/<RUN_ID>/computation/run_card.json` (normalized + parameter-resolved snapshot)
- `artifacts/runs/<RUN_ID>/computation/phase_state.json` (per-phase status + provenance pointers)

Recommended:
- `artifacts/runs/<RUN_ID>/computation/logs/<phase_id>/*.txt` (stdout/stderr snapshots)
- `artifacts/runs/<RUN_ID>/computation/workspace/` (copied phase I/O workspace for postmortem/debug)

## Steps (MVP)

1) Validate `run_card v2`:
   - unknown fields are ERROR
   - resolve parameters deterministically
   - validate phase DAG (ids, depends_on, I/O paths)
2) Enforce trust + containment:
   - shell backends require explicit trust (`--trust-project`)
   - phase paths must stay within project/workspace boundaries
3) Execute phases in topological order:
   - capture exit codes + logs
   - write per-phase outputs to workspace and copy declared outputs
4) Acceptance checks (optional):
   - JSON pointer numeric checks (min/max/max_abs)
5) Emit SSOT artifacts:
   - always write manifest/summary/analysis/report (even on failure or gate block)

## Gates (acceptance)

- If blocked by approval gates, must exit with a clear status and preserve SSOT artifacts.
- If any phase fails and `on_failure=fail-fast`, later phases must not run.
- `analysis.json` must include machine-extractable headline numbers when configured by the run-card.

## Extension roadmap

- v1: richer outcome gates (file hashes, schema checks, invariant checks).
- v2: first-class integration: computation workspace → MCP evidence (Outcome Gate) → research-writer.

