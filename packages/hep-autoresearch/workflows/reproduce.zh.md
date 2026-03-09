# reproduce — Reproduction-first（复现主结果）

## 目的

把“复现某篇文章的主结果”变成可执行任务：目标清晰、误差可解释、差异可定位、产物可复核。

## 输入

- `refkey`（目标论文 reading note）
- `target`（主结果定义；必须可量化/可对比）
  - 例：`"Table 1: sigma_tot (pb) at sqrt(s)=13 TeV"` 或 `"Fig.2 left: curve y(x)"`
- `tolerance`（允许误差；必须写清是 abs/rel 还是形状指标）

## 输出（产物）

必需（见 `docs/ARTIFACT_CONTRACT.md`）：
- `artifacts/runs/<TAG>/reproduce/manifest.json`
- `artifacts/runs/<TAG>/reproduce/summary.json`
- `artifacts/runs/<TAG>/reproduce/analysis.json`
- `team/runs/<TAG>/...`（双成员复核报告）

建议：
- `artifacts/runs/<TAG>/reproduce/figures/`（对照图）
- `artifacts/runs/<TAG>/reproduce/logs/`

## 步骤（MVP）

1) Planner 生成复现计划：
   - 关键假设（参数、截断、版本、随机种子、选择/重建）
   - 最小可行实现（先复现一个 headline number 或一个曲线的 proxy）
   - 预期误差与可能差异来源清单
2) Runner 执行计算（优先复用 `hep-calc` 或已有脚本），产物落盘到 artifacts。
3) Comparator 对比目标与结果：
   - 数值误差与稳定性（至少一个 audit slice）
   - 若不一致：差异归因（参数/版本/方法/随机数/截断）
4) Reviewer 做独立复核：不收敛则回退到步骤 1/2 修正。

## 门禁（验收）

- artifacts 三件套齐全，且 `analysis.json` 中能指向至少 1 个 machine-extractable headline number。
- 误差/差异必须可解释（即使未匹配，也要输出“未匹配的明确原因 + 下一步”）。
- 双成员复核收敛（或明确标记为 NOT_READY，并把 blocker 写入计划）。

## 扩展路线

- v1：支持多个 target（多图多表），并输出“复现覆盖率矩阵”。
- v2：自动从 LaTeX/PDF 抽取 result candidates（目标候选），半自动选择 target。

