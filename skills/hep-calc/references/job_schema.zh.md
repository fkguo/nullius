# hep-calc job schema（YAML/JSON）

> 语言：中文。English version: `references/job_schema.md`

本文件描述 `hep-calc` 的 job 配置字段、默认值与路径解析规则。完整 JSON Schema 见：`assets/job_schema.json`。

## 路径解析（默认规则）

- job 文件路径：`JOB_PATH`
- job 所在目录：`JOB_DIR = dirname(JOB_PATH)`
- job 中出现的相对路径字段，均按 `JOB_DIR` 解析为绝对路径后写入 `out_dir/job.resolved.json`。

## `job.resolved.json` 运行时元数据（`_meta`）

`scripts/run_hep_calc.sh` 会在 `job.resolved.json` 顶层写入 `_meta`（便于审计与下游工具定位）：

- `_meta.job_path`: 原始 job 文件绝对路径
- `_meta.job_dir`: job 文件所在目录（路径解析基准）
- `_meta.cwd`: 运行 `run_hep_calc.sh` 时的工作目录
- `_meta.out_dir`: 本次 out_dir 绝对路径
- `_meta.resolved_at`: `job.resolved.json` 生成时间（ISO8601）
- `_meta.auto_qft_enable_mode`: `explicit | implicit | default`
- `_meta.auto_qft_enable_implicit_reason`: 当 mode=implicit 时，记录触发条件（如 `has_process/has_model`）

## 最小 job（允许缺失输入，不可 silent fail）

下面的 job **不会执行** Mathematica entry，也不会做 LaTeX 对照，但必须生成完整 out_dir + 报告骨架，并明确标注步骤被跳过：

```yaml
schema_version: 1
name: minimal-skeleton
```

## Compute-only（不做 TeX 对照）

当你只想运行符号/数值计算而**不需要**和 LaTeX 数值对照时，保持 `latex.targets: []`（或直接省略 `latex`）即可。

- `tex/status.json` 会是 `status: SKIPPED` 且 `reason: no_targets_specified`
- `out_dir/summary.json` 会包含：`run_mode: compute_only`
- 只要计算步骤至少有一个 `PASS` 且没有 `ERROR/FAIL`，`overall_status` 会是 `PASS`（并在报告中明确披露未进行 TeX 对照）

## 字段说明（核心）

### `schema_version`（int）
- 默认：`1`

### `run_card`（path | null）

可选的“输入契约 / run-card”文件指针（YAML/JSON/MD 均可）。用途：
- 给回归评测 / provenance 提供一个**稳定的**输入说明入口（不必塞进 job.yml）
- 在 `manifest.json` 中会记录该指针；若文件可读，runner 会把它复制到 `out_dir/inputs/run_card.<ext>`

示例：

```yaml
run_card: run_card.yml
```

## auto_qft：自动出图 + 一圈振幅（符号）

当你希望从 **FeynRules（拉氏量/模型）→ FeynArts（出图）→ FormCalc（一圈振幅）** 自动化生成可审计产物时，使用 `auto_qft`：

```yaml
auto_qft:
  # enable 可省略：若未显式设置 enable，且同时提供 process + model，则会隐式开启 auto_qft
  feynrules_root: ~/Library/Wolfram/Applications/FeynRules   # 可省略；也可用环境变量 FEYNRULES_PATH
  model_files:
    - ~/Library/Wolfram/Applications/FeynRules/Models/SM/SM.fr
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

说明：
- `process.in/out` 推荐填 **ParticleName/AntiParticleName** 字符串（如 `e-`, `e+`）。  
  若解析有歧义/失败，可用 `process.in_fa/out_fa` 直接写 FeynArts 字段（如 `F[2,{1}]`, `-F[2,{1}]`）。
- 一圈默认输出为 **未重整化** 振幅；若启用 FormCalc 进一步约化（`auto_qft.formcalc.enable: true`），通常可得到更接近“显式 UV pole（1/ε）”的形式。若未启用 FormCalc，则输出通常是原始 FeynArts 表达式，UV 发散多为隐式（未展开/未约化）。
- `formcalc.enable: true` 时会尝试运行 FormCalc 做进一步化简/约化；若禁用（默认）则输出原始 FeynArts 振幅表达式（更稳健）。
- 关键产物位于：`out_dir/auto_qft/`（图：`diagrams/diagrams.pdf` + `diagrams/index.md`，振幅：`amplitude/amplitude_summed.m` + `amplitude/amplitude_summed.md`）。

可直接运行的示例 job：
- `assets/demo_auto_qft_ee_mumu.yml`
- `assets/demo_auto_qft_qed_bhabha.yml`（FeynArts-only：QED，e+ e- -> e+ e-）
- `assets/demo_auto_qft_model_build_sm_identity.yml`（model_build plumbing：inline_tex + rewrite stub）

### auto_qft（FeynArts-only：使用内置模型）

当你希望**不依赖 FeynRules**（或只想用 FeynArts 自带的模型，例如 `QED.mod/QED.gen`）时，可以启用 FeynArts-only 模式：

```yaml
auto_qft:
  # enable 可省略：若未显式设置 enable，且同时提供 process + model，则会隐式开启 auto_qft
  feynarts_model: QED
  feynarts_generic_model: QED
  process:
    in_fa:  ["-F[1,{1}]", "F[1,{1}]"]
    out_fa: ["-F[1,{1}]", "F[1,{1}]"]
  feynarts:
    loop_order: 1
    insertion_level: Particles
```

说明：
- 当设置了 `auto_qft.feynarts_model` 时，会跳过 FeynRules 导出步骤；此时必须提供 `process.in_fa/out_fa`（显式 FeynArts 字段）。
- 上面示例对应 FeynArts 的 `QED.mod`：电子/正电子为 `F[1,{1}]` / `-F[1,{1}]`（第一代）。

### auto_qft.model_build（从 LaTeX 辅助构建/增强 FeynRules 模型）

当你希望从论文/笔记的 LaTeX 中提取拉氏量块，并由 agent 显式提供“物理重写规则”来生成 FeynRules 可加载的拉氏量（再继续走 auto_qft 出图/振幅）时，使用 `auto_qft.model_build`。

**设计边界（重要）**
- skill 只做 **确定性、可审计** 的 TeX 预处理/提取/归一化与 `TeXForm` 解析，不猜物理。
- 物理含义映射（例如外源、手征结构、迹、γ 矩阵、约定等）由 agent 提供 `rewrite_wls` 显式实现。

最小示例（inline_tex；用于验证流水线是否贯通）：

```yaml
auto_qft:
  process:
    in:  ["e-", "e+"]
    out: ["mu-", "mu+"]

  model_build:
    enable: true
    inline_tex: "\\mathcal{L} = ... "
    base_model_files:
      - ~/Library/Wolfram/Applications/FeynRules/Models/SM/SM.fr
    rewrite_wls: path/to/rewrite_model_build.wls

    selection:
      mode: lagrangian_like
      include_patterns: ["\\\\mathcal\\{L\\}", "\\\\mathscr\\{L\\}"]

    parse_policy: best_effort
```

从 TeX 文件提取：

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

产物（审计入口）：
- `out_dir/auto_qft/model_build/tex_preprocess/blocks_all.json`
- `out_dir/auto_qft/model_build/tex_preprocess/blocks_selected.json`
- `out_dir/auto_qft/model_build/tex_preprocess/trace.json`
- `out_dir/auto_qft/model_build/parsed_blocks.m`（每行 `HoldComplete[...]`）
- `out_dir/auto_qft/model_build/generated_lagrangian.fr`（由 `rewrite_wls` 生成）
- `out_dir/auto_qft/model_build/status.json` / `summary.json`

`rewrite_wls` 接口约定（必须）：
- 文件需定义函数：`HepCalcModelBuildRewrite[parsedBlocks_, ctx_]`
- 建议返回 Association：
  - `"lagrangian"`：FeynRules 可接受的 Mathematica 表达式（将写入 `generated_lagrangian.fr`）
  - `"lagrangian_symbol"`（可选）：覆盖 job 中的 `auto_qft.lagrangian_symbol`
  - `"notes"` / `"warnings"`（可选）：写入审计摘要

**安全提示**：`rewrite_wls` 会在 Mathematica 中直接 `Get[...]` 执行（非沙箱）。仅在你信任该文件来源时使用。

### `tolerance`
全局容差：

```yaml
tolerance:
  rel: 1.0e-4
  abs: 1.0e-12
  per_target:
    some_id: { rel: 1.0e-6, abs: 1.0e-14 }
```

### `mathematica.entry`（path | null）
推荐 `.wls/.m`，`.nb` best-effort：

```yaml
mathematica:
  entry: path/to/entry.wls
```

执行环境由 `scripts/mma/run_job.wls` 提供：
- 已尝试加载：FeynCalc / FeynArts / FormCalc
- 入口脚本可调用：`HepCalcExportSymbolic[<|...|>]` 输出 `symbolic/symbolic.json`

#### `symbolic/symbolic.json` 约定（`HepCalcExportSymbolic`）

传给 `HepCalcExportSymbolic[<|...|>]` 的关联会经 **JSON 归一化** 后写入顶层 `data` 键
（`{schema_version, generated_at, data: <归一化后的关联>}`）。归一化（`scripts/mma/run_job.wls` 的
`HepCalcNormalizeForJSON`）：JSON 原子值、列表、字符串键的关联会原样保留；非字符串键会被转成字符串；任何
非 JSON 的 Wolfram 值会变成其 `InputForm` **字符串**。因此请让 `tasks`/`checks`/`notes` 的值保持 JSON 友好
（数字、字符串、布尔、字符串键的关联、列表）。按约定 `data` 含三个可选键：

- `data.tasks`（list）：交给 Julia 数值阶段（`scripts/julia/eval_numeric.jl`）。每个 task 是带 `id` 和 `kind` 的关联：
  - `kind: looptools` → Julia 在 `LoopTools` 模块中按名解析 `fn` 并以 `args` 调用之。`fn` 为任意 LoopTools.jl
    函数名（`B0`、`B0i`、`C0`…）；`args` 为位置参数列表。**LoopTools/Passarino–Veltman 约定：动量不变量与质量都取
    平方** —— 例如 `B0` 接收 `(p^2, m1^2, m2^2)`。整数参数会自动提升为 `Float64`；复数返回值序列化为
    `{ "re": ..., "im": ... }`。
    ```
    <|"id" -> "B0_s5", "kind" -> "looptools", "fn" -> "B0", "args" -> {5.0, 1.0, 1.0}|>
    ```
  - `kind: julia_expr` → Julia 会 `eval(Meta.parse(expr))`（危险；仅在你信任 job 时使用——见文末安全提示）。
  - 其它 `kind` → 记为 `SKIPPED`（`reason: unsupported_kind`）；不会静默失败。
- `data.checks`（关联，可选）：你自己的 PASS/FAIL 标志或锚点值（如 `<|"identity_holds" -> 1, "anchor_value" -> 1.6789e-3|>`）。
  skill **不** 解释它们——只按约定（JSON 归一化后）存于 `data.checks`。`report/audit_report.md` 只显示 symbolic 阶段
  状态 + 指向 `symbolic.json` 的指针，**不** 显示 check 的具体值；请读 `symbolic.json`。见 `references/output_contract.zh.md` →「计算内容约定」。
- `data.notes`（字符串列表，可选）：人类可读的推导/出处行，存于 `data.notes`。

若入口脚本运行了但从未调用 `HepCalcExportSymbolic`，runner 仍会写出一个 `data.tasks` 为空并带 note 的
`symbolic.json`（不静默失败）。

**数值阶段门控（run_hep_calc.sh）：** Julia 阶段仅当 `numeric.enable` 为真（或隐式开启）且 job 含 task 时运行；
若有 **任何** task，env-check 必须同时找到 `julia` 与 LoopTools.jl，否则整个阶段被阻断（先 `ERROR missing_julia`，
否则 `missing_looptools_jl`）—— 即使是仅含 `julia_expr` 的 job。阶段真正运行后，`eval_numeric.jl` 仅在存在
`looptools` task 时才加载 LoopTools，并把任何不支持的 `kind` 记为逐 task 的 `SKIPPED`。

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
    eq: "([-+]?(?:\\d+\\.\\d*|\\d*\\.\\d+|\\d+)(?:[eE][-+]?\\d+)?)"
  extractor_plugin: null   # or: path/to/plugin.py
  targets:
    - id: demo_b0
      label: eq:demo_b0
      # 可选：regex 直接抽取（优先于 label）
      # regex: "B_0\\(1,2,3\\)\\s*=\\s*([-+]?\\d+\\.\\d+)"
      # 可选：对 LaTeX 提取值做缩放（单位换算等），默认 1.0
      # scaling: 1000.0   # e.g. GeV -> MeV
      tolerance: { rel: 1e-4, abs: 1e-12 }
```

#### extractor plugin 接口
`latex.extractor_plugin` 指向一个 Python 文件，需定义：

```python
def extract(job: dict, tex_by_path: dict[str, str], out_dir: str) -> dict:
    # return: { target_id: {"value": 1.23, ...}, ... }
    ...
```

插件返回结果会覆盖同 id 的默认抽取结果。

**安全提示**：插件会被直接 `import` 执行（非沙箱）。只在你信任该插件代码时使用。

### `enable_fa_fc` / `feynarts_formcalc_spec`
```yaml
enable_fa_fc: false
feynarts_formcalc_spec: null
```

只要设置其一（`enable_fa_fc: true` 或提供非空 spec），会执行一个可审计的 pipeline stage：
- `out_dir/feynarts_formcalc/status.json`

默认情况下，需要你提供一个可执行入口：

```yaml
feynarts_formcalc_spec:
  entry: path/to/fa_fc_entry.wls
```

该 entry 会在加载 FeynArts/FormCalc 后执行，且可使用：
- `$HepCalcOutDir`（out_dir）
- `$HepCalcFAFCOutDir`（out_dir/feynarts_formcalc）

若仅设置 `enable_fa_fc: true` 但缺少 `feynarts_formcalc_spec.entry`，该步骤会被标注为 SKIPPED 并给出提示（不会 silent fail）。

### `integrations` / `tag`
```yaml
integrations: [research-team]
tag: M0-demo
```

当启用 research-team 集成时，必须提供 `tag`。

### `research_team_root`（可选）
当启用 research-team 集成时，默认会把产物同步到（自动探测到的）项目根目录下的：
`artifacts/runs/<TAG>/hep-calc/`。

如需显式指定同步根目录，可在 job 顶层设置：

```yaml
research_team_root: /path/to/research-team-project
```

也可用环境变量覆盖：`RESEARCH_TEAM_ROOT`。

若既没有显式指定，也找不到自动探测到的外部项目根目录，运行会 fail-closed，而不是把产物同步回 hep-calc 仓库或当前工作目录。
repo 内的 `skills/hep-calc/artifacts/` 与 `skills/hep-calc/process/` 仍只是 maintainer-fixture residue；公开 job 不应把它们当作隐式同步根目录。

## 安全提示：`julia_expr`

`symbolic/symbolic.json` 的 task 若使用：
- `kind: julia_expr`

则会在 Julia 侧执行 `eval(Meta.parse(expr))`。这是强能力但高风险的接口，只应在你信任 job 输入时使用。
