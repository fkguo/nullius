---
name: hep-calc
description: >
  General-purpose HEP calculation reproduction/audit runner that orchestrates
  Mathematica (FeynCalc/FeynArts/FormCalc/LoopTools/FeynRules) and/or Julia (LoopTools.jl).
  Supports: compute-only runs, LaTeX value auditing, auto-generation of Feynman diagrams + one-loop
  (unrenormalized) amplitudes (FeynRules→FeynArts→(optional)FormCalc), optional LaTeX-driven model_build
  scaffolding (agent-provided rewrite rules), and auditable out_dir + optional research-team sync.
---

# hep-calc

## Agent quick summary

Primary entry point:
- `bash scripts/run_hep_calc.sh --job job.yml [--out <dir>]`

Start here (audit-first):
- Human: `out_dir/report/audit_report.md`
- Agent/tooling (SSOT): `out_dir/summary.json` + `out_dir/manifest.json` (+ `out_dir/analysis.json`)
- Debug: `out_dir/logs/*.log` and per-step `status.json`

As an agent, always clarify with the user:
1) Goal: compute-only vs LaTeX audit vs auto_qft (diagrams/amplitude) vs model_build
2) Inputs: model files / process / TeX sources / targets
3) Deliverables: which artifacts to produce + where to point (paths under out_dir)

## When to use this skill

Use `hep-calc` when you need any of the following:
- Orchestrate Mathematica (FeynCalc/FeynArts/FormCalc) and/or Julia (LoopTools.jl) for symbolic/numeric HEP calculations.
- Auto-generate Feynman diagrams and one-loop (unrenormalized) amplitudes:
  - FeynRules → FeynArts → (optional) FormCalc reduction.
- Reproduce paper numbers and cross-check against LaTeX sources with tolerances (tex-audit).
- Produce auditable artifacts: per-stage PASS/FAIL/SKIPPED/ERROR + full logs + manifest/summary/analysis.
- Optionally: LaTeX-driven model_build scaffolding (extract/normalize/TeXForm-parse blocks) with agent-supplied rewrite rules.

## When NOT to use (hard boundaries)

Do NOT use this skill for:
- Renormalized/fully counterterm-inserted results (auto_qft produces bare one-loop amplitudes without counterterms; renormalization requires separate post-processing).
- Cross-sections / phase-space integration / event generation (this skill outputs diagrams + amplitudes, not observables).
- “Automatic physics understanding” of arbitrary LaTeX: model_build requires explicit agent rewrite rules; the skill does not guess physics.
- Untrusted code execution environments: plugins/rewrite hooks run without sandboxing (see Safety).

## Mode selection (job config → expected outputs)

| Goal | Job keys to set | Key outputs |
|---|---|---|
| Compute-only (no TeX comparison) | leave `latex.targets: []` (or omit targets) | `report/*`, `symbolic/*`, `numeric/*` |
| TeX audit (compare vs paper) | set `latex.tex_paths` + `latex.targets[]` (`id` + `label` or `regex`) | `tex/extracted.json`, `tex/comparison.json` |
| auto_qft (FeynRules model) | `auto_qft.process.in/out` + `auto_qft.model_files` + `auto_qft.lagrangian_symbol` | `auto_qft/diagrams/*`, `auto_qft/amplitude/*` |
| auto_qft (FeynArts-only) | `auto_qft.feynarts_model` + `process.in_fa/out_fa` | same (skips FeynRules export) |
| LaTeX→model_build→auto_qft | `auto_qft.model_build.*` + `rewrite_wls` + `base_model_files` | `auto_qft/model_build/*` + `auto_qft/*` |
| Custom FA/FC pipeline (scaffold) | `enable_fa_fc: true` + `feynarts_formcalc_spec.entry` | `feynarts_formcalc/status.json` |

## Copy-paste snippets (common cases)

Prefer starting from the demo jobs in `assets/` and editing them. These snippets are minimal, correct templates.

### A) QED Bhabha (FeynArts-only, compute-only)

Start from `assets/demo_auto_qft_qed_bhabha.yml`.

```yaml
schema_version: 1
latex:
  targets: []
numeric:
  enable: false
auto_qft:
  enable: true
  feynarts_model: QED
  feynarts_generic_model: QED
  process:
    in_fa:  ["-F[1,{1}]", "F[1,{1}]"]
    out_fa: ["-F[1,{1}]", "F[1,{1}]"]
```

### B) TeX audit (compare extracted paper numbers)

Start from `assets/demo_job.yml`. Minimal shape:

```yaml
latex:
  tex_paths: [paper.tex]
  targets:
    - id: demo_x
      label: eq:some_label   # OR provide regex instead of label
      tolerance: { rel: 1e-4, abs: 1e-12 }
```

The per-target PASS/FAIL lives in `out_dir/tex/comparison.json`.

### C) model_build (TeX → rewrite_wls → auto_qft)

Start from `assets/demo_auto_qft_model_build_sm_identity.yml`. Minimal shape:

```yaml
auto_qft:
  enable: true
  lagrangian_symbol: LFromTeX
  process:
    in:  ["e-", "e+"]
    out: ["mu-", "mu+"]
  model_build:
    enable: true
    tex_paths: [paper.tex]      # OR use inline_tex: "..."
    base_model_files: [path/to/base.fr]
    rewrite_wls: path/to/rewrite.wls
    parse_policy: best_effort   # best_effort: keep going with warnings; strict: fail on any parse error
```

model_build artifacts are under `out_dir/auto_qft/model_build/`.

## Compatibility & common pitfalls (agent-facing)

- `auto_qft.feynarts_model` + `auto_qft.model_build.*`: model_build is skipped in FeynArts-only mode. Choose one.
- Path resolution: all file paths in `job.yml` (e.g., `mathematica.entry`, `latex.tex_paths`, `auto_qft.model_build.rewrite_wls`) are resolved relative to the job file directory; verify the resolved paths in `out_dir/job.resolved.json`.
- `auto_qft.model_build.inline_tex` + `auto_qft.model_build.tex_paths`: ERROR (mutually exclusive).
- `latex.targets: []` + `auto_qft.enable: true`: OK (compute-only; diagrams/amplitude still produced).
- `enable_fa_fc: true` + `auto_qft.enable: true`: OK (both run; FA/FC stage is separate from auto_qft).
- FeynArts-only mode uses `process.in_fa/out_fa` (explicit FeynArts field syntax). When using FeynArts-only, do not set `process.in/out`—they are ignored.
- Missing dependencies are never silent: if `auto_qft` or `model_build` cannot run (e.g., missing `wolframscript`, FeynRules, or FeynArts), the stage writes `status.json` with `ERROR` + a `hint` describing what to install/fix.
- No built-in timeouts. If a kernel hangs, abort the run and inspect `out_dir/logs/*.log` (consider wrapping with an external timeout tool if needed).
- If a run is externally killed (e.g., via an OS signal or a timeout wrapper), `status.json` for the interrupted stage may be incomplete or missing; use `logs/*.log` to find the last activity.
- Prefer unique out_dir per run for auditability (reusing an out_dir overwrites artifacts/logs).

## Prerequisites (env_check)

Recommended first step:

```bash
bash scripts/check_env.sh --json /tmp/hep_calc_env.json  # runs also write meta/env.json inside out_dir
```

Core requirements:
- `python3` (reporting, extraction, comparison)
- `wolframscript` + Mathematica packages (FeynCalc/FeynArts/FormCalc; auto_qft also needs FeynRules for FeynRules mode)
- `julia` + `using LoopTools` (only if numeric stage enabled)

model_build (LaTeX→model) extra:
- `latexpand` for multi-file TeX flattening (missing latexpand + detected `\\input/\\include` → ERROR).

## Quick start

Run from the skill directory:

```bash
bash scripts/run_hep_calc.sh --job assets/demo_job.yml
```

Recommended: run env_check and write a machine-readable snapshot:

```bash
bash scripts/check_env.sh --json /tmp/hep_calc_env.json
```

auto_qft demo (FeynRules/SM): e- e+ -> mu- mu+:

```bash
bash scripts/run_hep_calc.sh --job assets/demo_auto_qft_ee_mumu.yml
```

auto_qft demo (FeynArts-only/QED): Bhabha scattering:

```bash
bash scripts/run_hep_calc.sh --job assets/demo_auto_qft_qed_bhabha.yml
```

model_build plumbing demo (LaTeX→rewrite hook; reuses SM LSM):

```bash
bash scripts/run_hep_calc.sh --job assets/demo_auto_qft_model_build_sm_identity.yml
```

Default out_dir: `process/hep-calc/<timestamp>/` (UTC).

Re-export SSOT artifacts (manifest/summary/analysis) for an existing out_dir:

```bash
python3 scripts/export_artifacts.py --out <out_dir>
```

## Key defaults (SSOT)

- Job format: YAML preferred; JSON supported. Resolved config is written to `out_dir/job.resolved.json`.
- Out dir default: `process/hep-calc/<timestamp>/` (UTC).
- Tolerance default: `rel=1e-4`, `abs=1e-12` (override per target).
- Auditable guarantee: no silent failure. Every stage writes `status.json`; missing prerequisites are reported as `SKIPPED` or `ERROR` with a `reason` (and often a `hint`).
- Notebook `.nb` is best-effort; prefer `.wls/.m`.
- FeynArts→FormCalc pipeline (`enable_fa_fc`) is OFF by default (runs only with an explicit spec).
- auto_qft runs when `auto_qft.enable: true`.
- Implicit enable (when `enable` is omitted) triggers if BOTH:
  1) `auto_qft.process` specifies particles: either `in_fa`+`out_fa` (FeynArts-only) or `in`+`out` (FeynRules mode)
  2) A model source is provided: `feynarts_model`, `model_files`, or `model_build` input

## Minimal workflow (recommended)

1) Write a job (YAML preferred; JSON supported).  
2) Run: `bash scripts/run_hep_calc.sh --job job.yml [--out <dir>]`  
3) Read `out_dir/report/audit_report.md`; follow per-step `status.json` + `logs/*.log` on failures/skips.  

## Minimal job example (inline)

This is a minimal **compute-only** job (no TeX comparison). Paths are resolved relative to the job file directory.

```yaml
schema_version: 1
name: minimal-compute-only
latex:
  targets: []
mathematica:
  entry: path/to/entry.wls   # optional; omit to skip symbolic stage
numeric:
  enable: false              # optional; disable if not needed
```

For full schema/options: see `references/job_schema.md` and `assets/job_schema.json`.

## Key artifacts (what to point users to)

- Report (human): `out_dir/report/audit_report.md`
- Summary (agent): `out_dir/summary.json`
- Full manifest/provenance (SSOT): `out_dir/manifest.json` + `out_dir/analysis.json`  
  (Mirrors also exist under `out_dir/report/` for back-compat with older tooling.)
- Logs: `out_dir/logs/*.log`
- auto_qft (if enabled):
  - diagrams: `out_dir/auto_qft/diagrams/diagrams.pdf`
  - amplitude (full expr): `out_dir/auto_qft/amplitude/amplitude_summed.m`
  - amplitude (human): `out_dir/auto_qft/amplitude/amplitude_summed.md`
- model_build (if enabled):
  - summary: `out_dir/auto_qft/model_build/summary.json`
  - generated snippet: `out_dir/auto_qft/model_build/generated_lagrangian.fr`
  - TeX preprocess: `out_dir/auto_qft/model_build/tex_preprocess/blocks_selected.json`
  - rewrite template: `assets/model_build/rewrite_template.wls`

## Stage IDs (status.json debugging)

Stages typically execute in this order (some are optional):
`env_check` → `feynarts_formcalc` → `tex_model_preprocess` → `auto_qft_model_build` → `auto_qft_one_loop` → `mathematica_symbolic` → `julia_numeric` → `tex_compare`.
Each stage writes a `status.json` with `PASS/FAIL/SKIPPED/ERROR/NOT_RUN`.
(Typically: `SKIPPED` means the stage was reached but not executed due to config/prereqs; `NOT_RUN` means the stage was not reached because earlier stages failed.)

## Safety (no sandbox)

The following features execute user/agent code. Only use with trusted inputs:
- `latex.extractor_plugin` (Python import)
- `julia_expr` (Julia eval)
- `auto_qft.model_build.rewrite_wls` (Mathematica `Get[...]`)

These hooks execute with full filesystem access (no sandbox).

## research-team / research-writer integration

If the job includes:

```yaml
integrations: [research-team]
tag: <TAG>
```

hep-calc syncs core artifacts to `artifacts/runs/<TAG>/hep-calc/` and ensures
`manifest.json` / `summary.json` / `analysis.json` exist for provenance.

See: `references/research_team_integration.md`.

## References (progressive disclosure)

- Job schema and examples: `references/job_schema.md`
- out_dir contract: `references/output_contract.md`
- Troubleshooting: `references/troubleshooting.md`
- research-team integration: `references/research_team_integration.md`
- hep-autoresearch adapter/eval: `references/hep_autoresearch_integration.md`
- LaTeX→model_build details: `references/model_build_latex.md`
- Chinese translations: append `.zh.md` (e.g. `references/output_contract.zh.md`)
