# hep-calc Output Contract (out_dir)

> Language: English. 中文版: `references/output_contract.zh.md`

This document defines the `out_dir` structure and the semantics of key files produced by `scripts/run_hep_calc.sh`.

## out_dir selection

- Public runs must pass `--out <dir>` explicitly.
- `--out` must point outside the hep-calc repo.
- `report/` remains the human-facing report area; the root JSON triplet is the only machine-readable SSOT surface.
- On reuse of an existing `--out`, the runner invalidates prior symbolic/auto_qft acceptance artifacts and root SSOT
  files before parsing the new job. A current process must recreate every required acceptance artifact; stale PASS
  files cannot satisfy postconditions. Other ancillary files may remain, so unique output directories are preferred.

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
    git_diff.patch              # when the source worktree is dirty; tracked changes
    source_tree_manifest.json   # when dirty; byte hashes for tracked changes and untracked files
```

Notes:
- `out_dir/manifest.json` / `summary.json` / `analysis.json` are the ecosystem SSOT (default ingestion for research-writer / downstream adapters).
- `out_dir/report/audit_report.md` is the human-facing audit summary.
- A dirty Git worktree is bound by `git.head` plus `report/source_tree_manifest.json`; the latter hashes every tracked
  change and untracked source file. `report/git_diff.patch` remains a readable tracked-change supplement and is not the
  complete dirty-source binding by itself.

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

The documented shell runner enforces postconditions after Wolfram processes exit. Process exit zero alone is not a
stage PASS. For a configured Mathematica entry, `symbolic/status.json` must exist and the symbolic output contract must
validate. For enabled `auto_qft`, both status and summary must explicitly be `PASS`, and
`auto_qft/amplitude/amplitude_summed.m` must be nonempty. Requested FormCalc additionally requires explicit FormCalc
`PASS` in both status surfaces, `amplitude_level: formcalc`, and a PASS
`auto_qft/formcalc/status.json` whose input/output byte counts and SHA-256 hashes match the current
`amps_raw.m` and `amplitude_summed.m`. FormCalc is reduced in a fresh Wolfram kernel; the FeynArts producer records
its current-run handoff in `auto_qft/producer_status.json` and `auto_qft/formcalc/handoff.json`.

The two explicit request gates, `auto_qft.enable` and `auto_qft.formcalc.enable`, accept only strict Booleans. Invalid
types fail during job resolution before an environment check or calculation starts.

## Compute content contract (`symbolic.json` / `numeric.json`)

For compute-only verification jobs (Mathematica entry + LoopTools.jl numeric handoff), the actual results live in two
files. Fail-closed `data.assertions` are promoted into the symbolic stage and overall status; their counts and failed
IDs are also shown in the audit report. `data.checks` remain uninterpreted data, and numeric `results` remain in JSON.

`symbolic/symbolic.json`:
```json
{ "schema_version": 1, "generated_at": "...",
  "data": { "tasks": [ {"id":"...","kind":"looptools","fn":"B0","args":[5.0,1.0,1.0]} ],
            "assertions": [ {"id":"identity_holds","passed":true,"residual":0.0,"tolerance":1.0e-12} ],
            "checks": { "identity_holds": 1, "anchor_value": 1.6789e-3 },
            "notes":  [ "..." ] } }
```
`data` is the **JSON-normalized** association passed to `HepCalcExportSymbolic` (JSON primitives/lists/string-keyed
associations preserved; non-string keys stringified; non-JSON Wolfram values become `InputForm` strings — see
`references/job_schema.md` for the contract).

- `data.assertions` is an optional list of fail-closed gates. Each entry requires a nonempty string `id` and Boolean
  `passed`; IDs must be unique. Optional `residual` and `tolerance` must be supplied together as finite, nonnegative real numbers, and
  `passed` must agree with `residual <= tolerance`. A false or invalid assertion produces a nonzero runner exit,
  `symbolic/status.json.status = FAIL`, and root `overall_status = FAIL`.
- External reconstruction parses JSON decimals exactly and preserves arbitrary-size integers before comparing
  `residual` with `tolerance`; sub-binary-float-ULP differences are not collapsed.
- The top-level `data` object is required. Entry messages/errors and early zero exits do not discard any already
  exported assertion counts; the external postcondition merges them into the final status when they remain readable.
- `data.checks` is preserved for backward-compatible anchors and diagnostics but is never interpreted as a gate.
- `symbolic/status.json.assertions` and `summary.json.symbolic_assertions` contain
  `{contract_valid, total, pass, fail, invalid, failed_ids, contract_errors}`.

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
- `symbolic_assertions` (summary only): fail-closed symbolic assertion counts and failed IDs

If a symbolic `FAIL` coexists with a later operational `ERROR`, root `overall_status` remains `FAIL`; individual stage
statuses retain the operational error rather than masking the failed scientific gate.

`meta/env.json` also contains (best-effort):
- `ok_full_toolchain`: bool
- `versions.feyncalc / feynarts / formcalc / looptools_jl`
