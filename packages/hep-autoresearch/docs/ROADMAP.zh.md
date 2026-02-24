# Roadmap（里程碑计划）

日期基准：2026-02-01（本文件是可执行计划；每个里程碑都要有验收标准）。

## 总体策略

- 先把“可靠性”做出来：证据链、产物契约、复核门禁、回归评测。
- 再扩展“自动化覆盖面”：从文献/复现/写作闭环，逐步推进到推导与更复杂计算。

## 里程碑总览

### M0（2–3 周）：项目规格与可复现骨架稳定

**用户可见结果**
- 项目有清晰的愿景/架构/路线图；任何新功能都必须对应一个验收测试与一个 eval case。

**交付物（paths）**
- `docs/VISION.md`, `docs/ARCHITECTURE.md`, `docs/WORKFLOWS.md`, `docs/EVALS.md`, `docs/SECURITY.md`
- `docs/CAPABILITY_AUDIT.md`（现有 skills + MCP 能力盘点与缺口图）
- 最小 `knowledge_base/`（至少 1 篇关键参考的笔记 + 1 个方法学 trace + 1 个 priors 文件）

**验收（DoD）**
- `research-team` preflight-only 能通过（Capsule/links/KB 最小数量满足）。

### M0.5（并行，必须在“更高自治”前完成）：门禁可测 + 自我进化可控

**目标**
- 把“同意点/门禁/自我进化”从原则变成可验证机制，避免后续实现出现绕过与退化。

**交付物**
- `docs/EVAL_GATE_CONTRACT.md`（L2/L3 的通过/失败/回滚/速率限制）
- `specs/reviewer_summary.schema.json`（Reviewer 结构化摘要，降低注入面）
- Approval gates 的测试计划（最小 3 类：正例/反例/绕过尝试）
- `docs/ORCHESTRATOR_STATE.md`（state/ledger/timeout/crash recovery 契约；为 pause/resume/approve 做硬底座）

**验收（DoD）**
- 评测与反投机（可执行规格）：
  - 至少定义 3 个 bypass case（A1/A2/A3 各 1 个），以 eval case 规格落盘（后续 runner 直接读取）
  - `docs/EVAL_GATE_CONTRACT.md` 中包含 Anti-gaming 场景（≥3 个）与 L2 “延迟/审批/quorum”政策
- Reviewer 隔离与升级授权：
  - `docs/ARCHITECTURE.md` 明确 Reviewer 信息隔离契约
  - escalation 授权策略明确：默认必须人类批准（Executor 不得单方面触发）
- approval gates 可测性：
  - `docs/APPROVAL_GATES.md` 中包含每类 gate 的“正例/反例/绕过”测试计划（至少覆盖 A1–A3）
  - `docs/APPROVAL_GATES.md` 明确 timeout 行为（默认不得“沉默即同意”）

### M1（4–6 周）：Paper ingestion + reading-note 自动化（不做计算也要靠谱）

**用户可见结果**
- 输入：INSPIRE recid / arXiv / DOI
- 输出：本地 `references/` 快照 + `knowledge_base/literature/` 阅读笔记（RefKey/链接/要点/可疑点/复核计划）

**验收**
- 至少 5 篇论文形成稳定 reading-note 模板与索引（可批量跑、可增量更新）。
- 每篇笔记都能被 `research-team` 引用门禁与链接门禁检查通过。

**并行交付（强烈推荐）**
- Orchestrator CLI v0：支持 `status/pause/resume/approve` 的最小交互闭环（见 `docs/ORCHESTRATOR_INTERACTION.md`）。
  - 要求：状态可恢复（见 `docs/ORCHESTRATOR_STATE.md`）。

### M2（6–10 周）：Reproduction-first v0（锁定 1 篇论文的 1 个主结果）

**用户可见结果**
- 从论文中选择 1 个明确、可量化主结果（图/表/数值）
- 自动生成复现计划 → 执行计算 → 输出 artifacts + 对比报告

**验收**
- `artifacts/runs/<TAG>/` 下存在 `manifest.json/summary.json/analysis.json`
- 复现误差与差异来源有明确定位（参数/版本/随机种子/截断/数值方法）

### M3（8–12 周）：Review→Revision 闭环 v0（对 LaTeX 工程有效）

**用户可见结果**
- 自动审稿（major/minor）+ 生成 revision plan + 自动改稿
- 输出：可编译 LaTeX + diff + 引用/证据门禁通过

**实现顺序（推荐，写入计划）**
- 先做 `W3a Draft`：默认用 `research-writer` 从 `Draft_Derivation.md` + `knowledge_base/` 生成可编译草稿（降低“无 paper_root 无法改稿”的阻塞）。
- 再做 `W3 Revision`：在可编译基线之上进入“审→改→再审”闭环。
- MCP 写作编排工具（`hep_run_writing_*`）作为中期增强：在 delegation protocol 完整后再逐步引入（避免双重编排/状态冲突）。

**验收**
- 至少 1 篇 LaTeX 工程（可以是你们自己的草稿）完成一次“审稿→改稿→再审”收敛。

### M4（3–6 个月）：多论文复现与回归评测套件（可靠性工程化）

**用户可见结果**
- 支持一组论文的复现任务队列；每次升级后自动跑 eval suite，防止退化。

**验收**
- `docs/EVALS.md` 中定义的核心 eval case 具有一键运行入口（可 CI 或本地）。
- 任一门禁退化（例如引用卫生/可编译/复现误差）都会被 eval 捕获。

### M5（6–12 个月）：对外可用的发布形态（alpha）

**用户可见结果**
- CLI/Web 入口之一（先 CLI 更稳）
- 用户可配置：权限、目录、网络、模型选择、预算
- 可分享的 run bundle（离线审阅、可复跑、可引用）

**验收**
- “新用户从零到跑通一个 demo”文档完备且可复现。

## 横向路线：自我进化（L1–L3，非训练权重）

把“越用越强”写成工程流程，而不是口号。详见：`docs/EVOLUTION.md`。

建议在各里程碑中强制纳入：
- **L1（记忆进化）**：每次 run 都沉淀 KB/trace/artifacts/team-reports（默认强制）
- **L2（策略进化）**：提示词/门禁/检索策略作为版本化配置，必须通过 eval suite 才能升级
- **L3（代码进化）**：把成功路径固化为 `toolkit/` 模块，并走 tests+eval+Reviewer 收敛

L4（训练权重）默认不走关键路径：只有在 eval suite 成熟、数据充足且有长期维护资源时再考虑。

现实约束（重要）：
- M1 之前：**只强制 L1（沉淀）**；L2/L3 只写合同与用例，不自动触发“自我修改”。
- 当且仅当存在可执行 eval runner（能跑 `evals/`）与回滚落盘后，才允许把 L2/L3 从“人工驱动”逐步升级为“半自动/自动”（仍默认需要人类同意）。

## 风险与对策（简述）

- **自动推导可靠性**：先把“检查器”做强（维度/极限/一致性/数值对照），再谈“自动推导生成”。
- **复现差异定位**：必须强制记录参数/版本/随机种子/截断/数值方法；否则复现不可控。
- **多模型成本**：用 `review-swarm`/`research-team` 做关键节点的双模型复核，把成本集中在“高价值门禁”。
