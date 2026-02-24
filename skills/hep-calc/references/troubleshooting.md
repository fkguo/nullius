# hep-calc Troubleshooting

> Language: English. 中文版: `references/troubleshooting.zh.md`

## 1) Environment check fails

Run:

```bash
bash scripts/check_env.sh --json /tmp/hep_calc_env.json
cat /tmp/hep_calc_env.json
```

`check_env.sh` also prints **env hints** at the end of stdout (installation/fix suggestions for humans + agents). You can also inspect `out_dir/logs/env_check.log` from a run.

Common causes:
- `wolframscript` not in PATH: ensure Mathematica is installed and `wolframscript` is runnable
- `wolframscript` exists but the kernel cannot run (license/activation): try `wolframscript -code '2+2'`; if you see activation/licensing errors, activate Mathematica/Wolfram Engine (e.g. open Mathematica once, or use `wolframscript -activate`)
- Mathematica packages fail to load: ensure FeynCalc/FeynArts/FormCalc are installed under `$UserBaseDirectory/Applications` (macOS: `~/Library/Wolfram/Applications/`)
- Julia `using LoopTools` fails: ensure LoopTools.jl is installed (your environment should support `using LoopTools`)

## 2) Mathematica stage fails

Inspect:
- `out_dir/logs/mma.log`
- `out_dir/symbolic/status.json`

If the entry is a `.nb`:
- Check whether `out_dir/inputs/*.snapshot.wls` was generated
- Note: `.nb` support is best-effort and may differ from FrontEnd macro/init semantics

## 3) Julia stage fails

Inspect:
- `out_dir/logs/julia.log`
- `out_dir/numeric/status.json`

Common causes:
- LoopTools.jl not installed or dynamic libraries missing (`using LoopTools` fails)
- The job emitted unsupported tasks (`kind` is not `looptools` / `julia_expr`)

## 4) LaTeX extraction/comparison issues

Inspect:
- `out_dir/tex/extracted.json`
- `out_dir/tex/comparison.json`
- `out_dir/logs/compare_tex.log`

Suggestions:
- For important targets, provide an explicit `regex` (most robust)
- Or provide `latex.extractor_plugin` for custom macro/table parsing

## 5) tex_model_preprocess / model_build fails (LaTeX-assisted model build)

Inspect:
- `out_dir/logs/tex_model_preprocess.log`
- `out_dir/auto_qft/model_build/tex_preprocess/status.json`
- `out_dir/auto_qft/model_build/tex_preprocess/blocks_selected.json`
- `out_dir/auto_qft/model_build/status.json`
- `out_dir/auto_qft/model_build/summary.json`

Common causes:
- `missing_tex_paths`: `auto_qft.model_build.tex_paths` not provided (and no `inline_tex`)
- `both_inline_and_tex_paths`: both `inline_tex` and `tex_paths` provided (not allowed)
- `missing_latexpand_multifile_detected`: TeX uses `\\input/\\include` but `latexpand` is missing (install TeXLive or provide an already-flattened `.tex`)
- `latexpand_failed`: `latexpand` returned non-zero (see stderr in `tex_model_preprocess.log`)
- `texform_parse_failed`: when `auto_qft.model_build.parse_policy: strict`, any selected line failing `TeXForm` parsing fails model_build
- `rewrite_wls_not_found` / `rewrite_function_missing`: `rewrite_wls` missing or does not define `HepCalcModelBuildRewrite`
- `rewrite_failed` / `rewrite_returned_no_lagrangian`: rewrite logic failed or did not return a valid `"lagrangian"`

Notes:
- With the default `parse_policy: best_effort`, parse failures are recorded in `model_build/summary.json.warnings`, and `parsedBlocks` is still passed to rewrite (agent decides whether it is fatal).
- `rewrite_wls` is executed directly in Mathematica (no sandbox). Only use if you trust the file source.

## 6) auto_qft fails (auto diagrams + one-loop amplitude)

Inspect:
- `out_dir/logs/auto_qft.log`
- `out_dir/auto_qft/status.json`
- `out_dir/auto_qft/summary.json`

Common causes:
- FeynRules not installed / wrong path: set `auto_qft.feynrules_root` or set `FEYNRULES_PATH`
- `.fr` referenced by `auto_qft.model_files` does not exist / `LoadModel` fails
- `auto_qft.lagrangian_symbol` does not exist (the model did not define that Lagrangian symbol)
- `auto_qft.process.in/out` particle names cannot be resolved: ensure they match your model `ParticleName/AntiParticleName`; if needed, use `process.in_fa/out_fa` to provide explicit FeynArts fields (e.g. `F[2,{1}]`, `-F[2,{1}]`)
- In FeynArts-only mode (when `auto_qft.feynarts_model` is set): you must provide `process.in_fa/out_fa` (explicit FeynArts fields)

Notes:
- auto_qft outputs an **unrenormalized** one-loop amplitude by design. If you enable FormCalc reduction (`auto_qft.formcalc.enable: true`), you more often get a form with explicit UV poles (1/ε). If FormCalc is disabled, outputs are typically raw FeynArts expressions where divergences may remain implicit (not expanded/reduced).
- If you enabled `auto_qft.formcalc.enable: true` and see FormCalc-related failures:
  - First inspect `out_dir/logs/auto_qft.log`
  - You may need to run FormCalc’s `compile` script in its install directory to build/install helper programs like `ReadForm`
