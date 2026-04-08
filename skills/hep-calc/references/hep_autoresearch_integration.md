# hep-calc → hep-autoresearch adapter / eval integration

> Language: English. 中文版: `references/hep_autoresearch_integration.zh.md`

This document describes how `hep-autoresearch` (or other ecosystem tooling) can ingest a `hep-calc` run for regression evaluation and provenance.

## SSOT triplet (out_dir root)

Every hep-calc run writes these files at the `out_dir/` root:

- `manifest.json`: pointers to inputs/parameters, environment versions, command pointers, output file list, and optional run-card pointer
- `summary.json`: headline items (key statuses/counts/selected numbers) plus definitions
- `analysis.json`: more detailed comparisons/diagnostics (currently a thin wrapper; can evolve)
- `report/audit_report.md`: human-facing audit summary (not part of the JSON ingestion contract)

## Minimal adapter ingestion flow

1) Run a job (either compute-only or tex_audit):

```bash
bash scripts/run_hep_calc.sh --job job.yml --out /tmp/hep_calc_run
```

2) Adapter reads `out_dir/summary.json` (fast decision path):

- `overall_status`: `PASS|PARTIAL|FAIL|ERROR`
- `run_mode`: `compute_only|tex_audit`
- `counts`: PASS/FAIL/SKIPPED counts from TeX comparison (compute-only typically has 0)
- `headline`: human-readable key statuses/numbers (with `definition`)
- `fingerprints.job_resolved_wo_meta_sha256`: stable fingerprint of the resolved job config, ignoring run-local `_meta`
- `fingerprints.outputs_files_sha256`: fingerprint of the output file *path list* (detects layout changes)

3) Adapter reads `out_dir/manifest.json` (provenance / evidence entrypoint):

- `job.original` / `job.resolved`: input card and resolved parameters
- `inputs[]`: input files (best-effort sha256 + redacted `source_path`)
- `environment.versions`: external dependency versions (useful for regression comparisons)
- `commands[]`: command pointers (e.g. `meta/command_line.txt`)
- `outputs.files[]`: deterministic sorted output file path list
- `steps`: per-stage status/reason (failure triage)

## Deterministic export for an existing out_dir (export artifacts)

If you have an existing out_dir that lacks the root SSOT triplet, run:

```bash
python3 scripts/export_artifacts.py --out /path/to/existing_out_dir
```

This rebuilds the SSOT triplet based on `job.resolved.json` + the out_dir contents (deterministic: `created_at` prefers `job._meta.resolved_at`).

## run-card (input contract) recommendation

When you want to separate an “input contract” from the job.yml (for L3 evolution / eval pipeline reuse), consider:

- Set `run_card: run_card.yml` at the job top level
- Put into the run-card: process, conventions, expected artifacts, comparison interpretation, and any explicit rules (especially the provenance of model_build rewrite rules)

The runner best-effort copies the run-card into `out_dir/inputs/run_card.<ext>` and records the pointer in `manifest.json`.

## Lightweight smoke example (for CI/regression)

This repo provides the lightest smoke runner (does not require Wolfram/Julia to successfully execute computation, but must produce full auditable wrappers):

```bash
python3 scripts/run_min_smoke.py --out-dir /tmp/hep_calc_run
test -f /tmp/hep_calc_run/manifest.json
test -f /tmp/hep_calc_run/summary.json
test -f /tmp/hep_calc_run/analysis.json
python3 -c 'import json; json.load(open("/tmp/hep_calc_run/manifest.json")); print("ok")'
```
