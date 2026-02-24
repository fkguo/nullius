# Architecture（总体架构）

本项目采用“工具层（MCP/脚本）+ 编排层（Orchestrator）+ 角色层（Agents）+ 门禁层（Gates）+ 产物层（Artifacts）+ 评测层（Evals）”的分层结构。

## 1) 分层与组件

### A. Tool layer（手脚）

- `hep-research-mcp`：INSPIRE/PDG/Zotero/LaTeX证据索引/写作导出等。
- 本地执行：shell、Python、Julia、Mathematica（通过 `hep-calc` 进行可审计编排）。

### B. Orchestrator（统一入口与路由）

职责：
- 把用户意图路由到合适的 workflow（复现/推导/写作/审稿/修改）。
- 管理 run 状态（计划、步骤、重试、停止、恢复）。
- 统一落盘：日志、产物、差异（diff）、证据引用。
- 触发门禁：Reviewer 收敛、证据门禁、可编译门禁、数值稳定性门禁等。

> 关键点：Orchestrator 不等于“更聪明的模型”，而是把流程与约束固定下来，降低幻觉风险与重复劳动。

### C. Agents（角色层：上下文/权限隔离）

默认必须集成“多角色分工”（科研正确性/质量/可复现性的核心机制），而不是可选功能。

最小必备角色集（每次严肃 workflow 默认启用）：

- **Planner**：把目标拆成可执行步骤（明确输入/输出/验收）。
- **Executor（Runner）**：执行工具调用与代码/计算/编译（产物必须落盘并可复跑）。
- **Reviewer**：独立复核与收敛门禁（不收敛则回退重做；关键结论不得绕过 Reviewer）。

按 workflow 按需启用的角色（仍建议默认开启，但允许在“轻量模式”关闭）：
- **Researcher**：只做检索与证据摘录（不做结论跳跃）。
- **Deriver/Checker**：做推导与一致性检查（维度、极限、符号约定、交叉验证）。
- **Writer/Editor**：写作与改稿（必须通过引用与证据门禁）。

你们现有的 `research-team` / `review-swarm` 已经覆盖了“多成员独立复核 + 收敛门禁”的关键机制。

实现要点（重要）：
- 多角色不要求“不同产品形态的 agent”（不强制 Codex/Claude/Gemini 各跑一个），但必须做到**上下文隔离**与**权限隔离**。
- 最关键的隔离是 Reviewer：Reviewer 的输入应以“证据包/产物/差异（diff）”为主，而不是看到 Executor 的全部对话与推理，以降低确认偏差。
- 在成本允许时，Reviewer 建议采用不同模型（Claude vs Gemini 等）形成更强的独立性；成本不足时也至少做到 clean-room（不互相看输出）。

#### Reviewer 信息隔离契约（必须写清楚并可测试）

Reviewer 默认只能看到：
- 最终产物（artifacts，且通过 schema 校验）
- 代码/文档 diff（最终 diff，不包含中间失败尝试的聊天记录）
- Planner 的验收标准（acceptance criteria）
- 结构化执行摘要（建议强制为 JSON，schema 见 `specs/reviewer_summary.schema.json`）

Reviewer 默认不能看到：
- Executor 的完整对话与推理过程
- 逐步工具调用日志（除非触发“升级请求/人工介入”）
- 中间失败尝试的细节（避免确认偏差与“解释过去”）

升级路径：
- 如果 Reviewer 无法基于以上信息做出判断：必须请求人工介入，或走“受控升级（escalation）”流程。

#### 信息隔离如何“被执行”（不是只靠提示词）

M0/M1 阶段的最低可行做法（可测试、可落地）：

- **进程隔离**：Reviewer 由独立 runner 进程调用（例如 `claude-cli-runner` / `gemini-cli-runner`），输入只是一份“review packet”文件。
- **工具隔离（clean-room）**：Reviewer 默认禁用 tools/MCP（或仅允许极少数“只读审计工具”，且必须显式列出）。
- **输入隔离**：Orchestrator 负责生成 `review_packet.txt`（或 `.md`），Reviewer 只看到该 packet + 输出契约；看不到 Executor 的长对话、失败尝试日志与未结构化的中间内容。
- **升级必须经人类批准**：Reviewer 若请求查看更多日志/文件，必须进入审批（视作一种 escalation gate），由人类决定是否放行，并把放行范围写入 ledger。

> 这与现有 `research-team` 的 `review_access_mode=packet_only` / `full_access`（leader-proxy）理念一致：Reviewer 的“看见范围”是一个可控变量，而不是默认全开。

更细的可执行规格（含验收点）见：[`docs/REVIEWER_ISOLATION.md`](REVIEWER_ISOLATION.md)。

受控升级（escalation）授权（必须避免绕过）：
- 默认：只有人类操作者可以批准 escalation（作为一种 approval gate），并必须落盘记录（run ledger）。
- 可选（未来）：引入独立的 Escalation-Reviewer 角色（权限最小化），由其决定是否允许 Reviewer 查看更详细日志。
- Executor 不得单方面触发 escalation（否则信息隔离失效）。

紧急 override（重要）：
- 任何绕过延迟窗口/强制立即生效的操作（例如 `--force-immediate`）必须落盘，并要求 48 小时内完成人工复核；未复核则冻结后续 promotion（详见 `docs/EVAL_GATE_CONTRACT.md`）。

### D. Gates（门禁层：默认 fail-fast）

建议把门禁分成两类：

- **硬门禁（Hard fail-fast）**：可编译、引用/链接完整性、证据门禁、不可执行/不可复现。
- **软门禁（Warn + debt）**：探索阶段允许欠债，但必须记录 debt 并在后续里程碑清偿。

### E. Artifacts（产物层：可审计）

统一产物契约（最小集合）：
- `manifest.json`：命令/参数/版本/输出路径/时间戳
- `summary.json`：用于图表/表格的统计摘要（带定义）
- `analysis.json`：从原始 artifacts 重新计算的“headline numbers”（带不确定度/误差控制说明）
- `logs/`：原始日志与关键 stderr/stdout

## 2) 数据与状态模型（概念）

- **Project**：一个长期研究/工具开发工程（当前目录下就是 project root）。
- **Run**：一次可复现执行（带 tag/run_id；所有产物归档）。
- **Task**：可执行的最小单位（有输入/输出/验收标准）。
- **Evidence**：支撑某个 claim 的引用与产物指针（文件路径/字段/截图/链接）。

## 3) 与现有工具的整合策略

优先“复用，不重写”：

- 复现与计算：尽量把计算编排交给 `hep-calc`（它已经定义了可审计输出契约）。
- 多成员复核：用 `research-team` / `review-swarm` 做“独立复核 + 收敛”。
- 写作与改稿：用 `research-writer` 的 paper scaffold 与卫生检查（并结合 `hep-research-mcp` 的导出/证据索引能力）。
- 文献抓取：把 INSPIRE/arXiv 的抓取与缓存统一放到 `references/`（并在 `knowledge_base/` 做人类可读笔记）。

### 3.1 与 MCP 内置编排工具的边界（避免“重复编排/状态冲突”）

`hep-research-mcp` 已经包含一些“更高层”的编排能力（例如写作闭环的 orchestrator 工具）。因此本项目的 Orchestrator 应定位为 **Meta-Orchestrator**：

- 面向用户：提供统一入口（W1/W2/W3/W4）+ 审批/暂停/恢复/导出体验
- 面向工具：在合适粒度上**委托**给 MCP（例如把写作闭环交给 `hep_run_writing_refinement_orchestrator_v1` 这类工具），而不是重复实现同一状态机
- 面向正确性：在委托前后做门禁（token gate / compile gate / evidence gate / reviewer convergence），并把 diff/产物/账本落盘

一句话：**我们负责“流程与约束”，MCP 负责“能力与执行”。**

委托协议（state ownership/handoff/超时/恢复）见：[`docs/MCP_DELEGATION_PROTOCOL.md`](MCP_DELEGATION_PROTOCOL.md)。

## 4) 实现顺序（避免“大而全失败”）

先做“Orchestrator + 产物契约 + eval 回归”，再逐步扩展角色与能力：

1) Paper ingestion（输入稳定、收益大、风险低）
2) Reproduction-first（以复现作为可靠性锚点）
3) Review→Revision 闭环（写作产物易验收：可编译、diff、引用）
4) 推导与代码生成（难度高，但可以在前面几步的基础上逐步增强）
