# hep-calc Output Contract (out_dir)

> Language: English. 中文版: `references/output_contract.zh.md`

This document defines the `out_dir` structure and the semantics of key files produced by `scripts/run_hep_calc.sh`.

## out_dir selection

- Public runs must pass `--out <dir>` explicitly.
- `--out` must point outside the hep-calc repo.
- `report/` remains the human-facing report area; the root JSON triplet is the only machine-readable SSOT surface.

## Required directories/files (even if no computation ran)

```
out_dir/
  manifest.json
  summary.json
  analysis.json
  job.resolved.json
  inputs/
    job.original.<yml|yaml|json>
  meta/
    command_line.txt
    env.json
  logs/
    run_hep_calc.log
    env_check.log
    tex_model_preprocess.log
    fa_fc.log
    auto_qft.log
    mma.log
    julia.log
    compare_tex.log
    generate_report.log
  feynarts_formcalc/
    status.json
  auto_qft/
    status.json
    summary.json
    model_build/
      status.json
      summary.json
      parsed_blocks.m            # if model_build enabled and TeXForm parsing attempted
      generated_lagrangian.fr    # if rewrite_wls succeeded
      tex_preprocess/
        status.json
        summary.json
        tex_files.json
        macros.json
        blocks_all.json
        blocks_selected.json
        trace.json
    feynarts_model/       # when auto_qft runs (FeynRules-exported .mod/.gen/.pars)
    topologies.m          # when auto_qft runs
    insertions.m          # when auto_qft runs
    diagrams/            # when auto_qft.export.diagrams=true (diagrams.pdf + diagrams_*.pdf + index.md)
    amplitude/           # amps_raw.m / amp_terms.m / amplitude_summed.m (+ optional .tex/.md) under this dir
  symbolic/
    symbolic.json
    status.json
  numeric/
    numeric.json
    status.json
  tex/
    extracted.json
    comparison.json
    status.json
  report/
    audit_report.md
```

Notes:
- `out_dir/manifest.json` / `summary.json` / `analysis.json` are the ecosystem SSOT (default ingestion for research-writer / downstream adapters).
- `out_dir/report/audit_report.md` is the human-facing audit summary.

## Deterministic export for an existing out_dir (export artifacts)

If you have an existing out_dir (missing the root SSOT triplet), or you want to rebuild them **without rerunning the calculation**, run:

```bash
python3 scripts/export_artifacts.py --out /path/to/existing_out_dir
```

This command rebuilds (based on `job.resolved.json` + the current out_dir contents):
`out_dir/manifest.json` / `out_dir/summary.json` / `out_dir/analysis.json`, and refreshes `out_dir/report/audit_report.md`.

## Step status contract

Each step `status.json` must include at least:
- `stage`: stable identifier (e.g. `feynarts_formcalc` / `mathematica_symbolic` / `julia_numeric` / `tex_compare`)
- `status`: `PASS` / `FAIL` / `SKIPPED` / `ERROR` / `NOT_RUN`
- `reason`: (optional) reason code or short description

**Required disclosure**: any SKIPPED/NOT_RUN must be explicitly visible in `report/audit_report.md` (the default report includes this).

## Compute content contract (`symbolic.json` / `numeric.json`)

For compute-only verification jobs (Mathematica entry + LoopTools.jl numeric handoff), the actual results live in two
files. **Note:** these are currently surfaced **only** in the JSON — the audit report promotes PASS/FAIL from the
TeX-audit stage (`tex/comparison.json`), not from `data.checks` or numeric `results`. Read the JSON directly.

`symbolic/symbolic.json`:
```json
{ "schema_version": 1, "generated_at": "...",
  "data": { "tasks": [ {"id":"...","kind":"looptools","fn":"B0","args":[5.0,1.0,1.0]} ],
            "checks": { "identity_holds": 1, "anchor_value": 1.6789e-3 },
            "notes":  [ "..." ] } }
```
`data` is the **JSON-normalized** association passed to `HepCalcExportSymbolic` (JSON primitives/lists/string-keyed
associations preserved; non-string keys stringified; non-JSON Wolfram values become `InputForm` strings — see
`references/job_schema.md` for the contract).

`numeric/numeric.json` (produced by `scripts/julia/eval_numeric.jl` from `data.tasks`):
```json
{ "schema_version": 1, "generated_at": "...",
  "results": [ {"id":"B0_s5","status":"OK","value":{"re":1.5696,"im":1.4050},"kind":"looptools","fn":"B0","args":[5.0,1.0,1.0]} ],
  "errors": [] }
```
- `results[].status`: `OK` / `ERROR` / `SKIPPED` (per task; `SKIPPED` for an unsupported `kind`).
- `results[].value`: a real number, or `{re, im}` for a complex return (e.g. LoopTools `B0` above threshold).
- `numeric/status.json` `status`:
  - `eval_numeric.jl` runs to completion **with tasks** → `PASS` iff `errors` is empty, else `ERROR`.
  - `eval_numeric.jl` runs but finds no tasks / a missing `symbolic.json` → `SKIPPED`.
  - the runner **pre-skips** the stage before invoking Julia (e.g. `numeric.enable: false` → `disabled_by_job`, no
    tasks → `no_tasks`, or missing `julia` / `LoopTools.jl`) → `SKIPPED`/`ERROR` written by `run_hep_calc.sh`.
  `counts: {total, ok, error, skipped}` is present **only** when the evaluator runs (normal completion or its own
  no-tasks skip); it is absent on missing-`symbolic.json` and on the shell pre-skips above.

## Key fields for downstream integration

`manifest.json` and `summary.json` (root SSOT; downstream may ignore unknown fields) include these useful fields:

- `run_mode`: `compute_only` | `tex_audit`
- `tex_compare_requested`: bool (derived from whether `latex.targets` is empty)
- `tex_compare_performed`: bool (whether the tex stage actually completed PASS/FAIL)
- `compute_passed` (summary only): bool (whether at least one compute stage PASSed)

`meta/env.json` also contains (best-effort):
- `ok_full_toolchain`: bool
- `versions.feyncalc / feynarts / formcalc / looptools_jl`
