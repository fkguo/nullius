# hep-calc 排错指南

> 语言：中文。English version: `references/troubleshooting.md`

## 1) 环境检查失败

运行：

```bash
bash scripts/check_env.sh --json /tmp/hep_calc_env.json
cat /tmp/hep_calc_env.json
```

`check_env.sh` 也会在 stdout 末尾打印 **env hints**（给人类/agent 的安装与修复建议），也可直接看 `out_dir/logs/env_check.log`。

常见原因：
- `wolframscript` 不在 PATH：确认 Mathematica 安装与 `wolframscript` 可执行
- `wolframscript` 存在但无法运行 kernel（license/activation）：先跑 `wolframscript -code '2+2'` 验证；若报激活/许可相关错误，先激活 Mathematica/Wolfram Engine（例如打开一次 Mathematica 完成激活，或使用 `wolframscript -activate`）
- Mathematica 包不可加载：确认 `~/Library/Wolfram/Applications/` 下安装了 FeynCalc/FeynArts/FormCalc
- Julia `using LoopTools` 失败：确认已安装 LoopTools.jl（用户环境中应可直接 `using LoopTools`）

## 2) Mathematica stage 报错

查看：
- `out_dir/logs/mma.log`
- `out_dir/symbolic/status.json`

若入口是 `.nb`：
- 看 `out_dir/inputs/*.snapshot.wls` 是否生成
- 注意：`.nb` 为 best-effort，可能与 FrontEnd 宏/初始化语义不同

## 3) Julia stage 报错

查看：
- `out_dir/logs/julia.log`
- `out_dir/numeric/status.json`

常见原因：
- LoopTools.jl 未安装或动态库不可用（`using LoopTools` 失败）
- job 输出的 tasks 不支持（`kind` 非 `looptools` / `julia_expr`）

## 4) LaTeX 抽取/对照异常

查看：
- `out_dir/tex/extracted.json`
- `out_dir/tex/comparison.json`
- `out_dir/logs/compare_tex.log`

建议：
- 对关键 target 显式提供 `regex`（最稳妥）
- 或提供 `latex.extractor_plugin` 做自定义宏/表格解析

## 5) tex_model_preprocess / model_build（从 LaTeX 辅助构建模型）失败

查看：
- `out_dir/logs/tex_model_preprocess.log`
- `out_dir/auto_qft/model_build/tex_preprocess/status.json`
- `out_dir/auto_qft/model_build/tex_preprocess/blocks_selected.json`
- `out_dir/auto_qft/model_build/status.json`
- `out_dir/auto_qft/model_build/summary.json`

常见原因：
- `missing_tex_paths`：未提供 `auto_qft.model_build.tex_paths`（且未提供 `inline_tex`）
- `both_inline_and_tex_paths`：同时提供了 `inline_tex` 与 `tex_paths`（不允许）
- `missing_latexpand_multifile_detected`：TeX 含 `\\input/\\include` 但系统缺少 `latexpand`（需安装 TeXLive 或提供已展开的 .tex）
- `latexpand_failed`：latexpand 返回非 0（查看 `tex_model_preprocess.log` 的 stderr）
- `texform_parse_failed`：当 `auto_qft.model_build.parse_policy: strict` 时，任一选中行 `TeXForm` 解析失败会导致 model_build 失败
- `rewrite_wls_not_found` / `rewrite_function_missing`：未提供或未正确实现 `rewrite_wls` / `HepCalcModelBuildRewrite`
- `rewrite_failed` / `rewrite_returned_no_lagrangian`：重写逻辑失败或未返回有效 `"lagrangian"`

提示：
- 默认 `parse_policy: best_effort`：解析失败行会被记录在 `model_build/summary.json.warnings` 中，并继续把 `parsedBlocks` 交给 rewrite（由 agent 决定是否致命）。
- `rewrite_wls` 会在 Mathematica 中直接执行（非沙箱）。仅在你信任该文件来源时使用。

## 6) auto_qft（自动出图/一圈振幅）失败

查看：
- `out_dir/logs/auto_qft.log`
- `out_dir/auto_qft/status.json`
- `out_dir/auto_qft/summary.json`

常见原因：
- FeynRules 未安装或路径不对：设置 `auto_qft.feynrules_root`，或设置环境变量 `FEYNRULES_PATH`
- `auto_qft.model_files` 指向的 `.fr` 不存在 / `LoadModel` 失败
- `auto_qft.lagrangian_symbol` 不存在（模型里没定义对应的拉氏量符号）
- `auto_qft.process.in/out` 粒子名无法解析：确认与你的模型 `ParticleName/AntiParticleName` 一致；必要时改用 `process.in_fa/out_fa` 直接写 FeynArts 字段（如 `F[2,{1}]`, `-F[2,{1}]`）
- 若使用 FeynArts-only（`auto_qft.feynarts_model` 已设置）：必须提供 `process.in_fa/out_fa`（显式 FeynArts 字段）

提示：
- auto_qft 输出为 **未重整化** 一圈振幅，这是预期行为。若启用 FormCalc 约化（`auto_qft.formcalc.enable: true`），通常更容易得到“显式 UV pole（1/ε）”的形式；否则多为原始 FeynArts 表达式，UV 发散往往是隐式的（未展开/未约化）。
- 若你启用了 `auto_qft.formcalc.enable: true` 但看到 formcalc 相关失败：
  - 优先查看 `out_dir/logs/auto_qft.log`
  - 可能需要在 FormCalc 安装目录运行其 `compile` 脚本以生成/安装 `ReadForm` 等辅助程序
