# Workflows（流程蓝图）

本文件把“科研全流程自动化”的愿景拆成可实现的 workflow，每个 workflow 都定义：输入、步骤、产物、门禁。

生命周期说明：本文件覆盖当前仍可使用的 **Pipeline A** Python CLI surface（`hep-autoresearch` / `hepar`）。长期规划仍然是在 TS orchestrator 成为唯一编排器后将这组 surface 一起退役；在那之前，这些说明仍是过渡期 Python 路径的有效操作文档。当前 installable `hepar run` 只保留兼容壳层命令，不再公开 workflow id；`ingest`、`reproduce`、`revision`、`literature_survey_polish` 与 `shell_adapter_smoke` 现在都只保留在 internal full parser，供 maintainer/eval/regression 使用。当前 remaining internal support launcher residue 只剩 `literature-gap`；`method-design`、`run-card`、`branch` 已降格为 retired-public maintainer helpers。

## 命名边界

- 当前面向用户与开发者的 workflow 名称统一使用语义名：`ingest`、`reproduce`、`computation`、`draft`、`paper_reviser`、`revision`、`derivation_check`。
- 活跃文档、脚本、测试、eval 后缀与运行时 payload 中，不再引入新的 `W1`/`W2`/`W3`/`W4` 命名。
- 若少数 schema enum、旧 fixture 或归档材料仍保留 `W*`，应视为历史兼容记录，而不是当前命名规范。
- `E4`、`E6`、`E14` 这类 eval 数字前缀继续作为稳定编号保留；需要语义化的是其后缀，而不是编号本身。


## ingest：Paper ingestion（文献入口）

**输入**
- INSPIRE recid / arXiv id / DOI / 关键词查询

**步骤**
1) 抓取元数据与源文件（LaTeX/PDF），落到 `references/`
2) 生成/更新 `knowledge_base/literature/<RefKey>.md`
3) 把关键 “可疑点/待核查点”写成明确 checklist，并链接到方法学 trace

**产物**
- `references/<id>/...`（快照）
- `knowledge_base/literature/<RefKey>.md`
- `knowledge_base/methodology_traces/literature_queries.md`（append-only 日志）

**门禁**
- 链接卫生、RefKey 完整性、最小字段齐全（recid/arXiv/外链）。

## reproduce：Reproduction-first（复现主结果）

**输入**
- 目标论文（RefKey）+ 主结果定义（例如“Fig.2 左图的曲线”或“Table 1 的某列数值”）

**步骤**
1) Planner 生成复现计划（参数、工具版本、预期误差、可能差异来源）
2) Runner 执行计算（优先走 `hep-calc` 或已有脚本），生成 artifacts
3) Comparator 做对照：误差、差异来源、敏感性分析（至少 1 个 audit slice）
4) Reviewer 双成员复核（通过则归档；不通过则返回重做）

**产物**
- `artifacts/runs/<TAG>/...`（manifest/summary/analysis/logs/figures）
- `team/runs/<TAG>/...`（成员报告 + adjudication）

**门禁**
- artifacts 契约完整、误差解释完整、独立复核收敛。

## revision：Review → Revision（审稿→改稿闭环）

**输入**
- LaTeX 工程（paper/ 或任意可编译项目）

**步骤**
1) Reviewer 生成结构化审稿报告（major/minor + 可执行改动建议）
2) Planner 生成 revision plan（每条建议映射到文件与修改策略）
3) Editor 执行修改（输出 diff；避免无证据新增）
4) 编译与卫生检查（引用/链接/宏/证据门禁）
5) 再审：直到收敛或触发 kill criteria（例如“需要人类决策的物理分歧”）

**产物**
- `paper/` 或目标目录的可编译版本
- `team/runs/<TAG>/...`（审稿与改稿记录）

**门禁**
- 可编译、引用完整、证据门禁通过、收敛。

## draft：Draft writing（草稿写作）

> 默认面向：已有 `Draft_Derivation.md` + `knowledge_base/`。

**输入**
- `Draft_Derivation.md`（定义/推导/符号/结论来源）
- `knowledge_base/`（阅读笔记与方法学 trace）
- （可选）`artifacts/`（用于结果段落/图表/数值）

**步骤**
1) Planner 冻结范围（章节结构、最小结论集、必须引用的 RefKeys）
2) A4 同意点：开始生成/修改 LaTeX 工程前必须征得人类同意
3) 生成 paper scaffold（优先 `research-writer` 或 MCP 导出）
4) 分节写作（每节必须附带证据指针；禁止无证据新增关键论断）
5) integrate + compile gate（必须可编译）
6) Reviewer 独立审阅；READY 后再进入 `revision`

**产物**
- draft paper（可编译版本）+ 编译日志
- 证据指针（notebook/KB/artifacts）

**门禁**
- A4（paper edits）、可编译、引用/证据门禁、Reviewer 信息隔离与收敛。

详见：`workflows/draft.zh.md`。

## derivation_check：Derivation + Checker（推导与一致性检查）

**输入**
- 目标推导（定义清楚的量与终点公式/数值）

**步骤**
1) 约定符号与规范（priors）
2) 推导分解为原子步骤（不跳步）并写入 notebook body
3) 自动检查：维度/极限/对称性/数值点对照（必要时 CAS/数值）

**产物**
- `Draft_Derivation.md`（推导与检查指针）
- `artifacts/`（检查脚本输出）

**门禁**
- “无跳步”与“至少一个可复现检查”通过（否则标记 UNVERIFIED 并给计划/kill criterion）。

## Phase C：研究能力扩展（补充）

- C1: `workflows/C1_literature_gap.md`（无 LLM 的 MCP INSPIRE 文献发现 bundle）
- C2: `workflows/C2_method_design.md`（方法设计脚手架 → 可运行 computation 插件项目）
