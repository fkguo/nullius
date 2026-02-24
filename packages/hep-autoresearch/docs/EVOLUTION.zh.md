# Evolution（自我进化：不训练模型也能变强）

本项目把“自我进化”定义为：在不改模型权重（不做 L4）的前提下，让系统在真实科研工作流中**越用越稳、越用越省人、越用越可复现**。

核心思想：把 agent 当作一个**可回归评测驱动的软件系统**，进化来自：
- 记忆沉淀（L1）
- 策略/提示词/工作流的版本化与 A/B（L2）
- 可复用代码与自动化工具链的持续积累（L3）

并且每次“进化”都必须经过门禁与回归评测，否则禁止合入。

自我进化的硬门禁（L2/L3）：见 `docs/EVAL_GATE_CONTRACT.md`（通过/失败、覆盖度、回滚、速率限制）。

## v0（已落地）：从失败 run 生成“改进提案”

目标：把“失败/不稳/缺口”转成**可执行、可审计**的下一步（而不是只留在对话里）。

入口：
- `hep-autoresearch propose --tag <NEW_TAG> --source-run-tag <OLD_TAG>`
- 或 `python3 scripts/run_evolution_proposal.py --tag <NEW_TAG> --source-run-tag <OLD_TAG>`

输出（JSON SSOT + 人类可读 Markdown）：
- `artifacts/runs/<NEW_TAG>/evolution_proposal/{manifest,summary,analysis}.json`
- `artifacts/runs/<NEW_TAG>/evolution_proposal/proposal.md`（提案清单，含证据指针与 A2 提醒）
- `artifacts/runs/<NEW_TAG>/evolution_proposal/trace_stub.md`（可复制进 KB 的 trace）

注意：v0 **只生成提案，不自动改代码/改评测**；任何代码或 eval 变更仍需 A2 人类批准。
默认会写入一条 KB trace 到 `knowledge_base/methodology_traces/`；如需保持工作区干净可加 `--no-kb-trace`。

## L1：记忆进化（最高 ROI，最安全）

目标：每次 run 都留下可复用资产，让下一次更快更稳。

落盘资产（建议默认强制）：
- `knowledge_base/literature/`：论文笔记（含 RefKey、稳定链接、可疑点、验证状态）
- `knowledge_base/methodology_traces/`：方法选择、失败原因、差异归因、复现实验记录（append-only）
- `knowledge_base/priors/`：符号/归一化/单位/截断的项目约定（避免“同一项目里符号漂移”）
- `artifacts/runs/<TAG>/...`：manifest/summary/analysis/logs（证据）
- `team/runs/<TAG>/...`：多成员复核报告与裁决（收敛记录）

自动化机会（不需要训练模型）：
- 自动生成 “下一步最小验证清单”（从失败原因与缺口抽取）
- 自动生成 “经验库”（错误→修复策略），例如安装失败、编译失败、数值不稳定等

## L2：策略/提示词/工作流进化（提示词当代码）

目标：让 Planner/Researcher/Writer/Reviewer 的策略更稳定、更少幻觉、更少无效尝试。

做法（建议强制流程）：
1) 从 `team/runs/` 与 `artifacts/` 中抽取失败/浪费的模式（例如检索召回差、改稿引入断引用）。
2) 产出“候选改进”（提示词、检索策略、门禁策略、模板结构）。
3) 在固定 eval suite 上跑回归（见 `docs/EVALS.md`），比较指标：
   - 通过率、干预次数、time-to-result、退化率
4) 通过才升级；否则回滚。

高收益方向（不训练模型）：
- **检索策略优化**：更好的 INSPIRE query 组合、引用扩展策略、去重/聚类规则
- **结构化输出模板**：减少自由文本，更多表格/清单/指针（artifact pointers）
- **不确定性标注策略**：强制 `LIKELY KNOWN / POSSIBLY NOVEL / UNCLEAR` + 证据指针 + “最小追加检查”
- **门禁策略调参**：探索期允许 debt，但强制记录与清偿；开发期 fail-fast

## L3：代码与工具链进化（把成功经验固化为模块）

目标：把重复劳动提炼成可复用模块与可测试工具。

机制：
- 把 workflow 中最常见、最可复用的部分抽象成 `toolkit/`（或 `src/`）模块：
  - ingestion（抓取+笔记模板化）
  - eval runner（静态检查器→逐步升级为可执行回归）
  - artifacts helpers（schema 校验、指针生成、diff/编译日志归档）
  - orchestrator state machine（pause/resume/approve）
- 每次代码变更必须：
  1) 通过 tests（如存在）与 eval suite，
  2) 通过 Reviewer 收敛，
  3) 经过人类同意点（默认需要同意写/改代码）。

高收益方向（不训练模型）：
- **autopatch 库**：把常见错误（编译/依赖/路径/格式）→ 具体补丁策略固化成 deterministic 修复器
- **“先 audit slice 再扩展”**的自动分级：先跑小样本/小扫描；通过稳定性门禁才扩到大规模

## 额外的高 ROI “变强”路径（不训练模型）

1) **回归评测优先**：eval suite 的覆盖度决定“进化速度”上限（没评测就没法安全改）。
2) **任务分解库**：把典型科研任务（复现图/对照表/改稿）沉淀成可复用 task templates。
3) **证据检索加速**：缓存、去重、引用图扩展、相似度检索（embedding/RAG）——不需要训练，只要工程化。
4) **符号/约定一致性工具**：自动生成符号表、检查单位/维度一致性、在论文与代码之间做映射表。
5) **“反例驱动”检查器**：为每个结论自动生成最小反例/极限测试（让错误更容易被暴露）。

## L4：改模型权重（是否值得？）

结论：**短期不建议作为主路径**，除非满足以下前提：

必要条件（缺一不可）：
- 有足够规模的高质量轨迹数据（工具调用/代码修改/复现对照/审稿改稿），且能去噪与标注“成功/失败/原因”；
- 有稳定、难以投机的 eval suite（否则会过拟合/奖励黑客）；
- 有可维护的训练/部署流程与版本管理（成本长期存在）。

在多数科研自动化场景里，L1–L3（加上更好的工具与评测）通常已经能覆盖 80% 的收益，且风险小得多。
因此：把 L4 作为“远期可选研究分支”，而不是近期路线图的关键路径。
