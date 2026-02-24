# hep-calc：LaTeX →（agent rewrite）→ FeynRules model_build

> 语言：中文。English version: `references/model_build_latex.md`

本文件描述 `auto_qft.model_build` 的 **可审计、确定性** 流程与扩展点。  
目标是把复杂论文（EFT/ChPT 等）中的拉氏量块“机械化提取/归一化/解析”，并把**物理含义映射**留给 agent 显式提供的 `rewrite_wls`。

## 设计边界（必须理解）

- skill 不猜物理：不自动推断外源、场的传播/非传播属性、约定或重整化方案。
- skill 只保证：
  1) TeX 展开（可选 latexpand）与抽取（环境 + display math），
  2) 宏 best-effort 展开（preamble 子集 + overrides），
  3) 语法归一化（例如 slash / h.c.），
  4) 将选中块交给 Mathematica `TeXForm` 做 **HoldComplete** 解析，
  5) 调用 agent 的 `rewrite_wls` 生成可加载的 `.fr` 片段。

## 相关 job 字段（速览）

见 `references/job_schema.zh.md` 与 `assets/job_schema.json`，这里只列关键项：

- `auto_qft.model_build.tex_paths`（list[path]）：TeX 文件
- `auto_qft.model_build.inline_tex`（string）：单段 TeX（与 tex_paths 互斥）
- `auto_qft.model_build.preprocess.flatten`（bool，默认 true）：用 latexpand 展开多文件
- `auto_qft.model_build.preprocess.macro_overrides`（dict）：覆盖/补充宏定义（best-effort）
- `auto_qft.model_build.selection.mode`：`lagrangian_like`（默认）或 `all_math_blocks`
- `auto_qft.model_build.selection.include_patterns/exclude_patterns`：Python regex（对 normalized_tex 过滤）
- `auto_qft.model_build.parse_policy`：`best_effort`（默认）或 `strict`
- `auto_qft.model_build.base_model_files`：FeynRules skeleton `.fr`（字段/参数/外源等声明）
- `auto_qft.model_build.rewrite_wls`：agent 提供的 Mathematica `.wls/.m`

## 产物与审计入口

`scripts/tex/prepare_model_build_tex.py` 写入：

- `out_dir/auto_qft/model_build/tex_preprocess/status.json`
- `out_dir/auto_qft/model_build/tex_preprocess/summary.json`
- `out_dir/auto_qft/model_build/tex_preprocess/tex_files.json`（flattened 路径与 sha256）
- `out_dir/auto_qft/model_build/tex_preprocess/macros.json`（提取的宏与 overrides）
- `out_dir/auto_qft/model_build/tex_preprocess/blocks_all.json`（全部行）
- `out_dir/auto_qft/model_build/tex_preprocess/blocks_selected.json`（被选中的行）
- `out_dir/auto_qft/model_build/tex_preprocess/trace.json`（宏展开/归一化事件）

`scripts/mma/run_auto_qft.wls`（model_build 子流程）写入：

- `out_dir/auto_qft/model_build/status.json`
- `out_dir/auto_qft/model_build/summary.json`（包含 warnings、rewrite_wls sha256 等）
- `out_dir/auto_qft/model_build/parsed_blocks.m`（每行 `expr_held = HoldComplete[...]`）
- `out_dir/auto_qft/model_build/generated_lagrangian.fr`（由 rewrite 生成）

## TeX 抽取范围（当前实现）

环境（逐行扫描 `\\begin{...}` / `\\end{...}`）：
- `equation`, `align`, `multline`, `eqnarray`, `gather`（含 `*` 版本）

display math（正则抽取）：
- `$$ ... $$`
- `\\[ ... \\]`

目前不抽取 inline `$ ... $`（可通过把相关内容放入 `inline_tex` 或写 extractor plugin/预处理解决）。

## 归一化规则（只为可解析，不含物理解释）

在 `blocks_all.json`/`blocks_selected.json` 中会同时保留：
- `raw_tex`（原始）
- `expanded_tex`（宏 best-effort 展开后）
- `normalized_tex`（为 `TeXForm` 做的归一化）

关键归一化：

- 对齐/标签清理：
  - 删除 `&`, `\\`, `\\label{...}`, `\\notag` / `\\nonumber`
- `h.c.`：
  - `\\text{h.c.}` / `\\mathrm{h.c.}` → `\\text{HC}` / `\\mathrm{HC}`（避免 `TeXForm` 因 `.` 崩溃）
- Slash：
  - `\\slashed{X}` → `\\text{Slash}(X)` → Mathematica 解析为 `Slash[X]`
  - `\\not{X}` / `\\not X` / `\\not\\!X` → `\\text{Slash}(X)`
  - `\\cancel{X}` → `\\text{Slash}(X)`（兼容部分作者习惯）

注意：`\\text{Slash}(...)` 只是可解析占位符；其物理含义由 agent 在 rewrite 中解释。

## parse_policy：best_effort vs strict

- `best_effort`（默认）：
  - `TeXForm` 解析失败的行会在 `model_build/summary.json.warnings` 中列出；
  - 仍会把 `parsedBlocks`（含 `ok=false` 的行）传给 `rewrite_wls`；
  - 由 agent 决定是否致命（例如忽略噪声行、或主动报错）。
- `strict`：
  - 任一选中行 `TeXForm` 解析失败即终止 model_build（可用于强一致性审计）。

## rewrite_wls：接口与职责（agent 侧）

`rewrite_wls` 必须定义：

- `HepCalcModelBuildRewrite[parsedBlocks_, ctx_]`

其中：
- `parsedBlocks` 是一个 list，每个元素含：
  - `"id"`, `"file"`, `"env"`, `"labels"`
  - `"normalized_tex"`（字符串）
  - `"ok"`（bool）
  - `"expr_held"`：`HoldComplete[...]`（或 `HoldComplete[$Failed]`）
- `ctx` 为 Association，包含 `job/out_dir/auto_dir/model_build_dir/lagrangian_symbol/parse_policy` 等

推荐返回 Association：
- `"lagrangian"`（必需）：FeynRules 可接受的 Mathematica 表达式
- `"lagrangian_symbol"`（可选）：覆盖导出符号名
- `"notes"` / `"warnings"`（可选）：写入审计摘要

参考模板与可运行示例：
- 模板：`assets/model_build/rewrite_template.wls`
- 示例（复用 SM 的 `LSM`）：`assets/model_build/rewrite_sm_identity.wls` + `assets/demo_auto_qft_model_build_sm_identity.yml`

agent 的典型职责：
- 选择哪些 blocks/terms 进入有效拉氏量（例如包含所有 `\\mathcal{L}_2, \\mathcal{L}_4` 块）
- 处理外源/背景常量（例如 `l_\\mu, r_\\mu, s, p, ...`）并在 base model 里声明为 parameters（非传播场）
- 为 `Slash[...]`、迹、手征 building blocks 等提供明确映射（不由 skill 推断）
- 明确声明任何额外规则（例如自定义宏展开、单位/符号约定）

## 安全模型（必须披露）

`rewrite_wls` 是 agent/用户提供的 Mathematica 代码，会被 `Get[...]` 执行（非沙箱）。  
仅在你信任该文件来源时运行；在共享环境中建议使用容器/隔离账户运行 Mathematica。
