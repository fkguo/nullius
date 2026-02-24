# hep-calc 与 research-team / research-writer 对接

> 语言：中文。English version: `references/research_team_integration.md`

当 job 中启用：

```yaml
integrations: [research-team]
tag: <TAG>
```

`scripts/run_hep_calc.sh` 会把核心产物同步到：

```
artifacts/runs/<TAG>/hep-calc/
  manifest.json
  summary.json
  analysis.json
  audit_report.md
  feynarts_formcalc.status.json
  auto_qft.status.json
  auto_qft.summary.json
  auto_qft.model_build.status.json
  auto_qft.model_build.summary.json
  auto_qft.model_build.generated_lagrangian.fr  # if generated
  auto_qft.model_build.parsed_blocks.m          # if generated
  auto_qft.model_build.tex_preprocess.status.json
  auto_qft.model_build.tex_preprocess.summary.json
  auto_qft.model_build.tex_preprocess.blocks_selected.json
  auto_qft.model_build.tex_preprocess.blocks_all.json
  auto_qft.model_build.tex_preprocess.macros.json
  auto_qft.model_build.tex_preprocess.tex_files.json
  auto_qft.model_build.tex_preprocess.trace.json
  auto_qft.diagrams.pdf                 # if generated
  auto_qft.diagrams.index.md            # if generated
  auto_qft.amplitude_summed.m           # if generated
  auto_qft.amplitude_summed.tex         # if generated
  auto_qft.amplitude_summed.md          # if generated
  job.resolved.json
  env.json
  FULL_OUT_DIR.txt
```

说明：
- `FULL_OUT_DIR.txt` 指向完整审计目录（包含 logs、symbolic/numeric/tex 的全量 JSON）
- research-writer / hep-autoresearch 可使用 `manifest.json/summary.json/analysis.json` 作为 provenance/证据入口（机器可读；与 out_dir 根目录 SSOT 三件套一致）

同步根目录（project root）规则：
- 你可以在 job 顶层显式指定：`research_team_root: /path/to/project`（优先级最高）
- 或设置环境变量：`RESEARCH_TEAM_ROOT`
- 若均未设置：会从运行时的 `cwd`/job 所在目录向上搜索，找到最近的包含 `artifacts/`（或 `artifacts/runs/`）的目录作为根；若找不到则回退到当前工作目录

最小建议：
- 将 `<TAG>` 与论文/里程碑一致（例如 `M0-demo`, `M1-benchmark`）
- 在论文或 Capsule 中引用 `artifacts/runs/<TAG>/hep-calc/audit_report.md`
