# Artifact contract（产物契约）

本项目的核心可靠性来自：**每一步都必须落盘成可审计产物**，而不是“口头说明已经做了”。

## 1) 目录约定

建议默认布局（可按 pipeline 再分层）：

- `artifacts/runs/<TAG>/`
  - `manifest.json`
  - `summary.json`
  - `analysis.json`
  - `logs/`
  - `figures/`
  - `tables/`

其中 `<TAG>` 建议与 `research-team` 的 run tag 同步（例如 `M2-r1`），方便把“复现/计算/改稿”与“独立复核报告”关联起来。

## 2) 三个核心文件（最小集合）

### A) `manifest.json`（怎么跑出来的）

必须能回答：
- 用什么命令、在什么目录、带什么参数跑的？
- 用了哪些关键版本/依赖？
- 生成了哪些输出文件？

最低字段（建议；具体 schema 见 `specs/artifact_manifest.schema.json`）：
- `schema_version`（整数）
- `created_at`（ISO 8601）
- `command` / `cwd`
- `params`（参数对象）
- `versions`（关键软件版本）
- `outputs`（输出路径映射 **推荐**；列表可接受但证据索引更弱）

如需在 manifest 中记录绝对路径，可设置 `HEPAR_RECORD_ABS_PATHS=1`。

建议的 `outputs` 形式（推荐）：

```json
{
  "main_plot": "figures/main.pdf",
  "raw_data": "data/raw.csv",
  "analysis": "analysis.json"
}
```

### B) `summary.json`（用于图/表的统计摘要）

必须能回答：
- 图表里的量到底怎么定义的（binning/windowing/selection）？
- 统计量如何计算（均值/方差/置信区间/拟合方式）？

最低字段：`schema_version`, `created_at`, `definitions`, `stats`, `outputs`  
（schema 见 `specs/artifact_summary.schema.json`）

### C) `analysis.json`（headline numbers 与误差/差异）

必须能回答：
- 最终“结论数字/曲线”是哪几个？精确定义是什么？
- 误差/不确定度怎么来的？（数值误差、截断误差、统计误差、系统误差的最小解释）
- 若是复现：与论文对比差多少？差异来源是什么？

最低字段：`schema_version`, `created_at`, `inputs`, `results`  
（schema 见 `specs/artifact_analysis.schema.json`）

## 2.5) 人类可读报告（推荐：`report.md`，JSON 为 SSOT）

问题：JSON 对机器/LLM 很友好，但对人类用户不够友好（不易快速定位 “这次跑了什么/结果是什么/该看哪里”）。

解决方案（项目级默认推荐）：
- 继续把 `manifest.json` / `summary.json` / `analysis.json` 作为 **SSOT**（可机检、可回归、可指针引用）。
- 同时生成一个 **派生的人类可读视图**：`report.md`（由 JSON 确定性渲染，方便阅读与审阅）。

`report.md` 建议至少包含：
- 运行摘要：workflow/tag/created_at/command
- 关键参数与版本（从 manifest 提取）
- Headline numbers 表格（包含 JSON pointers，例如 `analysis.json#/results/headlines/<key>`）
- 错误/告警（如有）
- 关键输出文件路径（如 plots/tables/diffs/logs）

注意：`report.md` 不替代 JSON；它必须可从 JSON 再生成（可丢弃、可重建），以避免“人类文档漂移”。

一键再生成（推荐）：

```bash
# 指定某个 artifact_dir
python3 scripts/render_artifact_report.py --artifact-dir artifacts/runs/<TAG>/<workflow_dir>

# 或：对一个 run tag 下的所有 artifact_dir 补齐 report.md（默认跳过已存在的 report.md）
python3 scripts/render_artifact_report.py --tag <TAG>
```

## 3) 可引用性（notebook/论文引用规则）

任何 headline number 在文字里出现时，必须可追溯到一个**机器可抽取指针**，例如：

- `artifacts/runs/M2-r1/analysis.json#/results/sigma_tot_pb`

并在同一段或相邻段给出最小语义说明（定义、单位、方案/尺度）。

## 4) 与现有流水线的兼容

- `hep-calc` 已经输出类似的 `manifest/summary/analysis`：优先对齐字段命名并避免重复造轮子。
- 若某 pipeline 必须输出额外文件（例如采样链、拟合权重、随机种子等），允许在 JSON 中增加字段，但不得删除最小集合字段。
