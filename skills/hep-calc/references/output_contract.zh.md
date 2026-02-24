# hep-calc 输出契约（out_dir）

> 语言：中文。English version: `references/output_contract.md`

本文件定义 `scripts/run_hep_calc.sh` 运行后的 out_dir 结构与关键文件语义。

## 默认 out_dir

- 默认：`process/hep-calc/<timestamp>/`（UTC）
- 可通过 `--out <dir>` 覆盖

## 必须存在的目录/文件（即使未执行计算）

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
    manifest.json
    summary.json
    analysis.json
```

说明：
- `out_dir/manifest.json` / `summary.json` / `analysis.json` 是生态圈 SSOT（hep-autoresearch / research-writer 等默认读取）。
- `out_dir/report/*.json` 为历史兼容与人类浏览保留；内容与 out_dir 根目录三件套一致（可视为镜像）。

## 旧 out_dir 的确定性导出（export artifacts）

如果你有旧的 out_dir（缺少根目录三件套），或你想在**不重跑计算**的前提下重建三件套，可以执行：

```bash
python3 scripts/export_artifacts.py --out /path/to/existing_out_dir
```

该命令会基于 `job.resolved.json` + 当前 out_dir 内容重建：
`out_dir/manifest.json` / `out_dir/summary.json` / `out_dir/analysis.json`（以及 `out_dir/report/*.json` 镜像）。

## Step status 约定

每个 step 的 `status.json` 至少包含：
- `stage`: 标识（如 `feynarts_formcalc` / `mathematica_symbolic` / `julia_numeric` / `tex_compare`）
- `status`: `PASS` / `FAIL` / `SKIPPED` / `ERROR` / `NOT_RUN`
- `reason`:（可选）原因枚举或简述

**强制披露**：任何 SKIPPED/NOT_RUN 必须在 `report/audit_report.md` 明确出现（本 skill 默认报告已包含）。

## Report / manifest 关键字段（用于下游集成）

`report/manifest.json` 与 `report/summary.json` 除了 `overall_status` 外，还会包含以下有用字段（向后兼容，可忽略未知字段）：

- `run_mode`: `compute_only` | `tex_audit`
- `tex_compare_requested`: bool（由 `latex.targets` 是否为空推断）
- `tex_compare_performed`: bool（tex stage 是否实际完成 PASS/FAIL）
- `compute_passed`（仅 summary 中）：bool（是否至少有一个计算阶段 PASS）

`meta/env.json` 还会包含（best-effort）：
- `ok_full_toolchain`: bool
- `versions.feyncalc / feynarts / formcalc / looptools_jl`
