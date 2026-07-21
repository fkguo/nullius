# hep-calc 输出契约（out_dir）

> 语言：中文。English version: `references/output_contract.md`

本文件定义 `scripts/run_hep_calc.sh` 运行后的 out_dir 结构与关键文件语义。

## out_dir 选择

- Public 运行必须显式传入 `--out <dir>`。
- `--out` 必须指向 hep-calc 仓库之外的目录。
- `report/` 继续只承载面向人的报告；根目录 JSON 三件套是唯一的机器可读 SSOT。
- 若复用已有 `--out`，runner 会在解析新 job 之前使旧的 symbolic/auto_qft 验收产物和根级 SSOT 文件失效。
  当前进程必须重新生成全部必要验收产物，旧 PASS 文件不能满足 postcondition。其他辅助文件可能保留，
  因此仍建议每次使用唯一输出目录。

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
    git_diff.patch              # 源码 worktree 为 dirty 时生成；仅含已跟踪改动
    source_tree_manifest.json   # dirty 时生成；逐文件绑定已跟踪改动与未跟踪文件字节
```

说明：
- `out_dir/manifest.json` / `summary.json` / `analysis.json` 是生态圈 SSOT（research-writer / downstream adapters 等默认读取）。
- `out_dir/report/audit_report.md` 是面向人的审计摘要。
- 若 Git worktree 为 dirty，完整源码绑定由 `git.head` 与 `report/source_tree_manifest.json` 共同给出；后者逐项
  记录所有已跟踪改动和未跟踪源码文件的字节哈希。`report/git_diff.patch` 只是便于阅读的已跟踪改动补充，
  不能单独充当完整 dirty-source 绑定。

## 旧 out_dir 的确定性导出（export artifacts）

如果你有旧的 out_dir（缺少根目录三件套），或你想在**不重跑计算**的前提下重建三件套，可以执行：

```bash
python3 scripts/export_artifacts.py --out /path/to/existing_out_dir
```

该命令会基于 `job.resolved.json` + 当前 out_dir 内容重建：
`out_dir/manifest.json` / `out_dir/summary.json` / `out_dir/analysis.json`，并刷新 `out_dir/report/audit_report.md`。

## Step status 约定

每个 step 的 `status.json` 至少包含：
- `stage`: 标识（如 `feynarts_formcalc` / `mathematica_symbolic` / `julia_numeric` / `tex_compare`）
- `status`: `PASS` / `FAIL` / `SKIPPED` / `ERROR` / `NOT_RUN`
- `reason`:（可选）原因枚举或简述

**强制披露**：任何 SKIPPED/NOT_RUN 必须在 `report/audit_report.md` 明确出现（本 skill 默认报告已包含）。

文档规定的 shell runner 会在 Wolfram 进程退出后强制检查 postcondition；进程返回零本身不等于阶段 PASS。
对于已配置的 Mathematica 入口，`symbolic/status.json` 必须存在且符号输出契约必须有效。对于已启用的
`auto_qft`，status 与 summary 都必须显式为 `PASS`，且 `auto_qft/amplitude/amplitude_summed.m` 必须非空。
若请求 FormCalc，还要求两个状态面都显式报告 FormCalc `PASS`，并有 `amplitude_level: formcalc`。
此外，`auto_qft/formcalc/status.json` 必须为 `PASS`，且其中输入、输出的字节数和 SHA-256 必须分别匹配
本次运行的 `amps_raw.m` 与 `amplitude_summed.m`。FormCalc 在新的 Wolfram kernel 中约化；FeynArts
producer 的本次交接记录在 `auto_qft/producer_status.json` 与 `auto_qft/formcalc/handoff.json`。

两个显式请求开关 `auto_qft.enable` 与 `auto_qft.formcalc.enable` 只接受严格布尔值。类型无效时会在
环境检查或计算开始之前，于 job 解析阶段失败。

## 计算内容约定（`symbolic.json` / `numeric.json`）

对于"compute-only 验证"类 job（Mathematica 入口 + LoopTools.jl 数值交接），真正的结果存在这两个文件里。
fail-closed `data.assertions` 会进入符号阶段和 overall status，断言计数与失败 ID 也会显示在 audit 报告中。
`data.checks` 仍是不经解释的数据，数值 `results` 仍保存在 JSON 中。

`symbolic/symbolic.json`：
```json
{ "schema_version": 1, "generated_at": "...",
  "data": { "tasks": [ {"id":"...","kind":"looptools","fn":"B0","args":[5.0,1.0,1.0]} ],
            "assertions": [ {"id":"identity_holds","passed":true,"residual":0.0,"tolerance":1.0e-12} ],
            "checks": { "identity_holds": 1, "anchor_value": 1.6789e-3 },
            "notes":  [ "..." ] } }
```
`data` 是传给 `HepCalcExportSymbolic` 的关联经 **JSON 归一化** 后的结果（JSON 原子/列表/字符串键关联原样保留；
非字符串键转成字符串；非 JSON 的 Wolfram 值变成 `InputForm` 字符串——见 `references/job_schema.zh.md`）。

- `data.assertions` 是可选的 fail-closed 断言列表。每项必须含非空字符串 `id` 和布尔值 `passed`，
  且 ID 必须唯一。
  可选的 `residual` 与 `tolerance` 必须同时给出，且均为有限、非负实数；`passed` 必须与
  `residual <= tolerance` 一致。false 或无效断言会令 runner 返回非零、
  `symbolic/status.json.status = FAIL`，并令根级 `overall_status = FAIL`。
- 外部重建会精确解析 JSON 十进制小数并保留任意长度整数，然后再比较 `residual` 与 `tolerance`；
  小于二进制浮点 ULP 的差异不会被折叠。
- 顶层 `data` 对象是必需的。入口 message/error 或提前零退出不会丢弃已经可读的断言计数；外部
  postcondition 会把这些计数合并进最终状态。
- `data.checks` 仅保留为向后兼容的锚点与诊断数据，永不解释为 gate。
- `symbolic/status.json.assertions` 与 `summary.json.symbolic_assertions` 含
  `{contract_valid, total, pass, fail, invalid, failed_ids, contract_errors}`。

`numeric/numeric.json`（由 `scripts/julia/eval_numeric.jl` 从 `data.tasks` 生成）：
```json
{ "schema_version": 1, "generated_at": "...",
  "results": [ {"id":"B0_s5","status":"OK","value":{"re":1.5696,"im":1.4050},"kind":"looptools","fn":"B0","args":[5.0,1.0,1.0]} ],
  "errors": [] }
```
- `results[].status`：`OK` / `ERROR` / `SKIPPED`（逐 task；不支持的 `kind` 记为 `SKIPPED`）。
- `results[].value`：实数，或复数返回时为 `{re, im}`（如阈上的 LoopTools `B0`）。
- `numeric/status.json` 的 `status`：
  - `eval_numeric.jl` 含 task 正常跑完 → `errors` 为空则 `PASS`，否则 `ERROR`。
  - `eval_numeric.jl` 跑了但无 task / 缺 `symbolic.json` → `SKIPPED`。
  - runner 在调用 Julia 前 **预跳过**（如 `numeric.enable: false` → `disabled_by_job`、无 task → `no_tasks`、缺
    `julia` / `LoopTools.jl`）→ 由 `run_hep_calc.sh` 写出 `SKIPPED`/`ERROR`。
  `counts: {total, ok, error, skipped}` **仅** 在 evaluator 真正运行时存在（正常跑完，或其自身的无-task 跳过）；
  缺 `symbolic.json` 及上述 shell 预跳过时不含 `counts`。

## Report / manifest 关键字段（用于下游集成）

`manifest.json` 与 `summary.json`（根目录 SSOT）除了 `overall_status` 外，还会包含以下有用字段（向后兼容，可忽略未知字段）：

- `run_mode`: `compute_only` | `tex_audit`
- `tex_compare_requested`: bool（由 `latex.targets` 是否为空推断）
- `tex_compare_performed`: bool（tex stage 是否实际完成 PASS/FAIL）
- `compute_passed`（仅 summary 中）：bool（是否至少有一个计算阶段 PASS）
- `symbolic_assertions`（仅 summary 中）：fail-closed 符号断言计数与失败 ID

若符号 `FAIL` 与后续运行阶段的 `ERROR` 同时存在，根级 `overall_status` 保持为 `FAIL`；逐阶段状态仍保留
运行错误，避免其掩盖失败的科学 gate。

`meta/env.json` 还会包含（best-effort）：
- `ok_full_toolchain`: bool
- `versions.feyncalc / feynarts / formcalc / looptools_jl`
