# hep-calc (agent skill)

A general-purpose reproduction/audit runner for HEP calculations. It drives
Mathematica (FeynCalc / FeynArts / FormCalc / LoopTools / FeynRules) and/or Julia
(LoopTools.jl) from a single job file, and every stage writes an auditable status —
missing tools surface as `SKIPPED`/`ERROR` with a reason rather than a silent pass.
Declared symbolic assertions fail closed: any false or malformed assertion makes
the symbolic stage and overall run fail, while legacy `data.checks` remain uninterpreted.
The shell runner also validates required stage artifacts after each Wolfram process exits;
a zero process exit without a completed status artifact is not accepted as success.
When `--out` is reused, prior symbolic/auto_qft acceptance artifacts and root status
surfaces are invalidated before the new job is parsed, so stale PASS files cannot satisfy
the new run. `auto_qft.enable` and `auto_qft.formcalc.enable`, when present, must be JSON/YAML
Booleans rather than truthy numbers or strings.
It can reproduce a computation, audit LaTeX values against a recomputation,
auto-generate one-loop (unrenormalized) amplitudes, and optionally scaffold a model
from LaTeX.

Designed to be driven by a tool-using agent; the commands below are what the agent
runs, and you can run them yourself for reproducibility and debugging.

## Requirements

- `python3` — reporting, extraction, comparison
- `wolframscript` + Mathematica packages (FeynCalc / FeynArts / FormCalc; FeynRules mode also needs FeynRules)
- `julia` + `LoopTools.jl` — only when the numeric stage is enabled
- `latexpand` — only for multi-file LaTeX flattening in `model_build`

Check the environment first:

```bash
bash scripts/check_env.sh --json /tmp/hep_calc_env.json
```

## Quick start

Run a demo job from the skill directory. Public runs must pass `--out` to a
directory outside this repo:

```bash
bash scripts/run_hep_calc.sh --job assets/demo_job.yml --out /tmp/hep_calc_demo
```

When `auto_qft.formcalc.enable: true`, the FeynArts producer and FormCalc reducer run in separate Wolfram kernels.
The reducer defaults to a 2048 MB Wolfram-memory cap and publishes a reduced amplitude only after a current-run
hash-bound handoff succeeds.

Read `<out>/report/audit_report.md`; on any failure or skip, follow the per-stage
`status.json` and `logs/*.log`. Re-export the manifest/summary for an existing run:

```bash
python3 scripts/export_artifacts.py --out <out_dir>
```

## Docs

- `SKILL.md` — mode selection, job schema, key defaults, and integration.
- `references/job_schema.md` — job file format (Chinese variant: `references/job_schema.zh.md`).
- `references/output_contract.md` — artifacts and status contract.
- `references/model_build_latex.md` — LaTeX→model scaffolding.
- `references/research_team_integration.md` — research-team / research-writer handoff.
- `references/troubleshooting.md` — common pitfalls.

## Repository layout

- `scripts/` — `run_hep_calc.sh` (entrypoint), `check_env.sh`, `export_artifacts.py`, `generate_report.py`, `compare_tex.py`
- `scripts/mma/` — Mathematica drivers (`.wls`)
- `scripts/julia/` — Julia numeric evaluation
- `scripts/tex/` — LaTeX preparation for `model_build`
- `assets/` — demo job files
- `references/` — schema, contract, and troubleshooting docs (English + Chinese)
