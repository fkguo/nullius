# hep-calc job schema (YAML/JSON)

> Language: English. 中文版: `references/job_schema.zh.md`

This document describes hep-calc job configuration fields, defaults, and path resolution rules. For the complete JSON Schema, see `assets/job_schema.json`.

## Path resolution (default rules)

- Job file path: `JOB_PATH`
- Job directory: `JOB_DIR = dirname(JOB_PATH)`
- Any relative path fields in the job are resolved against `JOB_DIR` and written as absolute paths into `out_dir/job.resolved.json`.

## Runtime metadata in `job.resolved.json` (`_meta`)

`scripts/run_hep_calc.sh` writes a top-level `_meta` into `job.resolved.json` for auditability and downstream tooling:

- `_meta.job_path`: absolute path to the original job file
- `_meta.job_dir`: job directory (base for path resolution)
- `_meta.cwd`: working directory when running `run_hep_calc.sh`
- `_meta.out_dir`: absolute out_dir for this run
- `_meta.resolved_at`: timestamp when `job.resolved.json` was generated (ISO8601)
- `_meta.auto_qft_enable_mode`: `explicit | implicit | default`
- `_meta.auto_qft_enable_implicit_reason`: when mode=`implicit`, records the trigger conditions (e.g. `has_process/has_model`)

## Minimal job (missing inputs allowed; no silent failures)

The job below will **not** run a Mathematica entry and will not do any LaTeX comparison, but it must still create a complete out_dir + report skeleton, and explicitly mark skipped steps:

```yaml
schema_version: 1
name: minimal-skeleton
```

## Compute-only mode (no TeX comparison)

If you only want symbolic/numeric computation and **do not** need a LaTeX value audit, keep `latex.targets: []` (or omit `latex` entirely).

- `tex/status.json` will be `status: SKIPPED` with `reason: no_targets_specified`
- `out_dir/summary.json` will include `run_mode: compute_only`
- If at least one compute stage PASSes and there is no `ERROR/FAIL`, `overall_status` will be `PASS` (and the report will disclose that TeX comparison was not performed)

## Field reference (core)

### `schema_version` (int)
- Default: `1`

### `run_card` (path | null)

Optional run-card (input contract) pointer (YAML/JSON/MD). Use cases:
- Provide a **stable** input contract entrypoint for hep-autoresearch / regression eval / provenance (without stuffing it into job.yml)
- The pointer is recorded in `manifest.json`; if readable, the runner best-effort copies it to `out_dir/inputs/run_card.<ext>`

Example:

```yaml
run_card: run_card.yml
```

## auto_qft: automatic diagrams + one-loop amplitude (symbolic)

When you want an auditable pipeline from **FeynRules (model/Lagrangian) → FeynArts (diagrams) → (optional) FormCalc (one-loop amplitude)**, use `auto_qft`:

```yaml
auto_qft:
  # `enable` can be omitted: if you do NOT explicitly set enable, and you provide BOTH process + model,
  # hep-calc will enable auto_qft implicitly.
  feynrules_root: /path/to/FeynRules             # optional; or set env var FEYNRULES_PATH
  model_files:
    - /path/to/Models/SM/SM.fr
  lagrangian_symbol: LSM
  process:
    in:  ["e-", "e+"]
    out: ["mu-", "mu+"]
  feynarts:
    loop_order: 1
    insertion_level: Particles
    exclude_topologies: [Tadpoles]
    counterterms: false
  formcalc:
    enable: false
    pave_reduce: LoopTools
  export:
    diagrams: true
    amplitude_md: true
    amplitude_tex: false
    per_diagram: false
```

Notes:
- `process.in/out` should typically be the model’s **ParticleName/AntiParticleName** strings (e.g. `e-`, `e+`).
  If parsing is ambiguous/fails, use `process.in_fa/out_fa` with explicit FeynArts fields (e.g. `F[2,{1}]`, `-F[2,{1}]`).
- The default output is an **unrenormalized** one-loop amplitude. If you enable FormCalc reduction (`auto_qft.formcalc.enable: true`), you more often get a form with explicit UV poles (1/ε). With FormCalc disabled, the output is typically a raw FeynArts expression where divergences may remain implicit (not expanded/reduced).
- Key artifacts live under `out_dir/auto_qft/`:
  - diagrams: `diagrams/diagrams.pdf` + `diagrams/index.md`
  - amplitude: `amplitude/amplitude_summed.m` + `amplitude/amplitude_summed.md`

Runnable demo jobs:
- `assets/demo_auto_qft_ee_mumu.yml`
- `assets/demo_auto_qft_qed_bhabha.yml` (FeynArts-only: QED, e+ e- → e+ e-)
- `assets/demo_auto_qft_model_build_sm_identity.yml` (model_build plumbing: inline_tex + rewrite stub)

### auto_qft (FeynArts-only: use built-in models)

If you want to **avoid FeynRules** (or you only want FeynArts built-in models like `QED.mod/QED.gen`), use FeynArts-only mode:

```yaml
auto_qft:
  # `enable` can be omitted: if you do NOT explicitly set enable, and you provide BOTH process + model,
  # hep-calc will enable auto_qft implicitly.
  feynarts_model: QED
  feynarts_generic_model: QED
  process:
    in_fa:  ["-F[1,{1}]", "F[1,{1}]"]
    out_fa: ["-F[1,{1}]", "F[1,{1}]"]
  feynarts:
    loop_order: 1
    insertion_level: Particles
```

Notes:
- When `auto_qft.feynarts_model` is set, hep-calc skips the FeynRules export step; you must provide `process.in_fa/out_fa` (explicit FeynArts fields).
- The example above matches FeynArts `QED.mod`: electron/positron are `F[1,{1}]` / `-F[1,{1}]` (1st generation).

### auto_qft.model_build (LaTeX-assisted model build / augmentation)

If you want to extract Lagrangian blocks from paper/notes LaTeX, and have an agent explicitly provide “physics rewrite rules” that produce a FeynRules-loadable Lagrangian (and then continue with auto_qft diagrams/amplitude), use `auto_qft.model_build`.

**Design boundary (important)**
- The skill performs **deterministic, auditable** TeX preprocessing/extraction/normalization and `TeXForm` parsing; it does not infer physics.
- Physics mapping (external sources, chiral structures, traces, gamma matrices, conventions, etc.) is implemented explicitly by the agent via `rewrite_wls`.

Minimal example (inline_tex; for plumbing verification):

```yaml
auto_qft:
  process:
    in:  ["e-", "e+"]
    out: ["mu-", "mu+"]

  model_build:
    enable: true
    inline_tex: "\\\\mathcal{L} = ... "
    base_model_files:
      - /path/to/Models/SM/SM.fr
    rewrite_wls: path/to/rewrite_model_build.wls

    selection:
      mode: lagrangian_like
      include_patterns: ["\\\\\\\\mathcal\\\\{L\\\\}", "\\\\\\\\mathscr\\\\{L\\\\}"]

    parse_policy: best_effort
```

Extracting from TeX files:

```yaml
auto_qft:
  process:
    in:  ["e-", "e+"]
    out: ["mu-", "mu+"]
  model_build:
    enable: true
    tex_paths:
      - /path/to/paper.tex
    preprocess:
      flatten: true
      expand_usepackage: false
      macro_overrides: {}
```

Artifacts (audit entrypoints):
- `out_dir/auto_qft/model_build/tex_preprocess/blocks_all.json`
- `out_dir/auto_qft/model_build/tex_preprocess/blocks_selected.json`
- `out_dir/auto_qft/model_build/tex_preprocess/trace.json`
- `out_dir/auto_qft/model_build/parsed_blocks.m` (each line as `HoldComplete[...]`)
- `out_dir/auto_qft/model_build/generated_lagrangian.fr` (generated by `rewrite_wls`)
- `out_dir/auto_qft/model_build/status.json` / `summary.json`

`rewrite_wls` interface (required):
- The file must define: `HepCalcModelBuildRewrite[parsedBlocks_, ctx_]`
- Recommended return Association:
  - `"lagrangian"`: Mathematica expression acceptable to FeynRules (written into `generated_lagrangian.fr`)
  - `"lagrangian_symbol"` (optional): override `auto_qft.lagrangian_symbol`
  - `"notes"` / `"warnings"` (optional): written into the audit summary

**Security note**: `rewrite_wls` is executed in Mathematica via `Get[...]` (no sandbox). Only use when you trust the file source.

### `tolerance`

Global tolerance:

```yaml
tolerance:
  rel: 1.0e-4
  abs: 1.0e-12
  per_target:
    some_id: { rel: 1.0e-6, abs: 1.0e-14 }
```

### `mathematica.entry` (path | null)

Prefer `.wls/.m`; `.nb` is best-effort:

```yaml
mathematica:
  entry: path/to/entry.wls
```

The execution environment is provided by `scripts/mma/run_job.wls`:
- it attempts to load: FeynCalc / FeynArts / FormCalc
- your entry can call: `HepCalcExportSymbolic[...]` to write `symbolic/symbolic.json`

`symbolic/symbolic.json` contract (simplified):
- `data.tasks`: list
  - `kind: looptools` → Julia calls `LoopTools.<fn>(args...)`
  - `kind: julia_expr` → Julia executes `eval(Meta.parse(expr))` (dangerous; only use for trusted jobs)

### `numeric`

```yaml
numeric:
  enable: true
  engine: julia
```

### `latex`

```yaml
latex:
  tex_paths: [paper.tex]
  label_patterns:
    eq: "([-+]?(?:\\\\d+\\\\.\\\\d*|\\\\d*\\\\.\\\\d+|\\\\d+)(?:[eE][-+]?\\\\d+)?)"
  extractor_plugin: null   # or: path/to/plugin.py
  targets:
    - id: demo_b0
      label: eq:demo_b0
      # Optional: direct regex extraction (takes priority over label)
      # regex: "B_0\\\\(1,2,3\\\\)\\\\s*=\\\\s*([-+]?\\\\d+\\\\.\\\\d+)"
      # Optional: scale the extracted LaTeX value (unit conversion), default 1.0
      # scaling: 1000.0   # e.g. GeV -> MeV
      tolerance: { rel: 1e-4, abs: 1e-12 }
```

#### extractor plugin interface

`latex.extractor_plugin` points to a Python file that must define:

```python
def extract(job: dict, tex_by_path: dict[str, str], out_dir: str) -> dict:
    # return: { target_id: {"value": 1.23, ...}, ... }
    ...
```

Plugin results override the default extraction results for matching `id`.

**Security note**: the plugin is imported/executed directly (no sandbox). Only use when you trust the code.

### `enable_fa_fc` / `feynarts_formcalc_spec`

```yaml
enable_fa_fc: false
feynarts_formcalc_spec: null
```

Setting either (`enable_fa_fc: true` or a non-null spec) enables an auditable pipeline stage:
- `out_dir/feynarts_formcalc/status.json`

In the default pattern you provide an executable entry:

```yaml
feynarts_formcalc_spec:
  entry: path/to/fa_fc_entry.wls
```

The entry runs after loading FeynArts/FormCalc and can use:
- `$HepCalcOutDir` (out_dir)
- `$HepCalcFAFCOutDir` (out_dir/feynarts_formcalc)

If you set `enable_fa_fc: true` but do not provide `feynarts_formcalc_spec.entry`, the step is marked SKIPPED with a hint (no silent failure).

### `integrations` / `tag`

```yaml
integrations: [research-team]
tag: M0-demo
```

When enabling research-team integration, `tag` is required.

### `research_team_root` (optional)

With research-team integration enabled, hep-calc defaults to syncing artifacts into:
`artifacts/runs/<TAG>/hep-calc/` under the detected project root.

To explicitly set the sync project root at the job top level:

```yaml
research_team_root: /path/to/research-team-project
```

Or override via the environment variable `RESEARCH_TEAM_ROOT`.

If neither an explicit root nor an auto-detected external project root exists, the run fails closed instead of syncing into the hep-calc repo or the current working directory.
Repo-local `skills/hep-calc/artifacts/` and `skills/hep-calc/process/` paths remain maintainer-fixture residue only; public jobs should not rely on them as implicit sync roots.

## Security note: `julia_expr`

If a `symbolic/symbolic.json` task uses:
- `kind: julia_expr`

then Julia executes `eval(Meta.parse(expr))`. This is powerful but high-risk; only use it when you trust the job inputs.
