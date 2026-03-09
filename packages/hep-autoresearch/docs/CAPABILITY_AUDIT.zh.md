# Capability audit（现有能力审计 + 缺口图）

目标：在“充分了解现有已开发 skills + hep-research-mcp”前提下审阅路线图，避免重复造轮子，并明确还需要开发哪些组件/skills/MCP 工具。

本文件是审计基线（SSOT）：后续 reviewer 评审与路线图修改应以此为依据。

## 0) 审计范围与证据来源

本次审计基于以下可验证来源：

- 已安装 skills 的 `SKILL.md`（核心相关项）：
  - `research-team`
  - `review-swarm`
  - `hep-calc`
  - `research-writer`
  - `claude-cli-runner`
  - `gemini-cli-runner`
  - `prl-referee-review`
- `hep-research-mcp`（MCP server）的“可调用工具清单（listTools）”：
  - 由脚本生成：[`scripts/extract_hep_research_mcp_tool_inventory.py`](../scripts/extract_hep_research_mcp_tool_inventory.py)
  - 输出（SSOT）：[`references/hep-research-mcp/tool_inventory.json`](../references/hep-research-mcp/tool_inventory.json)
  - 人类可读摘要：[`references/hep-research-mcp/tool_inventory.md`](../references/hep-research-mcp/tool_inventory.md)
- 运行中 `hep-research-mcp` 服务器健康信息（用于确认本机启用/未启用的集成）：
  - server: `@hep-research/hep-research-mcp` version `0.3.0`（darwin/arm64）
  - tool_mode: `standard`
  - INSPIRE API base: `https://inspirehep.net/api`
  - Zotero Local API 已启用（`http://127.0.0.1:23119`）
  - PDG 未配置（`PDG_DB_PATH` 未设置；pdg tools 仍会暴露但会返回“未配置”提示）

> 注意：这不是“读完所有实现代码”的审计；它是以工具/契约/接口为中心的能力盘点，用于指导下一步实现与评测。

## 1) 现有 skills 能力（与本项目直接相关）

### 1.1 research-team（核心：双成员独立复核 + 收敛门禁）

定位：
- 把研究任务变成里程碑制 workflow：prework → team cycle → convergence gate
- 强制 reproducibility capsule、知识库层、门禁/债务记录（exploration→development 递进）

你能直接复用的能力：
- 双成员独立复核与收敛门禁（可用 Claude+Gemini）
- “证据优先”的输出与运行痕迹归档（team/runs/<tag>/）
- preflight-only（不调用外部 LLM）用于早期 deterministic 检查

缺口/需要本项目补的：
- 它不是一个通用 Orchestrator：需要我们在 ingest / reproduce / draft / revision / derivation_check 上补齐执行器与状态机

### 1.2 review-swarm（核心：clean-room 双模型审阅/收敛）

定位：
- 对同一 packet/prompt 做 Claude+Gemini clean-room 双审阅
- 强输出契约（VERDICT + 固定 headers）

你能直接复用的能力：
- 严格的“计划/文档”审阅（我们已用于 plan review 并收敛）
- 作为 Reviewer 侧的独立意见来源（成本可控，快速收敛）

### 1.3 hep-calc（核心：HEP 计算编排 + LaTeX 对照 + 可审计产物）

定位：
- Mathematica/Julia（可选 FeynRules→FeynArts→FormCalc）编排
- 输出审计报告 + manifest/summary/analysis + 日志
- 可与 research-team artifacts 目录对接

你能直接复用的能力：
- reproduce（reproduction-first）与 derivation_check（checker）中的“可执行计算 + 可审计产物”底座
- 对照 LaTeX 数值（当目标论文有明确数值/表格时）

缺口/需要本项目补的：
- Orchestrator 的“任务选择、预算、同意点、暂停恢复、对照与差异归因”仍需补齐

### 1.4 research-writer（核心：paper scaffold + 证据门禁 + LaTeX 卫生）

定位：
- 从 research-team 项目生成 arXiv-ready paper scaffold
- LaTeX/Markdown 卫生与 evidence gate（防无证据新增）

你能直接复用的能力：
- revision（review→revision）与 publication/export 的写作侧工具链
- 对外分享的 paper bundle 与 trace

缺口/需要本项目补的：
- “审稿→revision plan→改稿→再审”闭环的 Orchestrator 状态机（谁改、何时改、如何回滚）

### 1.5 prl-referee-review（核心：PRL 风格审稿报告）

定位：
- 调用 Claude/Gemini 生成 PRL editor+referee 风格报告（严格输出契约）

你能直接复用的能力：
- revision 的 reviewer 组件之一（风格化审稿输出）

注意事项：
- 它是 workflow skill（依赖 runner），本质上仍是文本审阅；必须与“可编译/引用/证据”门禁联动

### 1.6 claude-cli-runner / gemini-cli-runner（核心：外部模型执行器）

定位：
- 将外部 LLM CLI 调用标准化（文件输入、输出落盘、重试）

你能直接复用的能力：
- 为本项目提供可替换的“模型执行后端”（不绑定单一供应商）

## 2) hep-research-mcp 能力盘点（按类别）

以下按“对科研 workflow 的作用”归类（工具名以 `listTools` 为准；详见 [`references/hep-research-mcp/tool_inventory.md`](../references/hep-research-mcp/tool_inventory.md)）：

### 2.0 工具清单概览（证据）

当前 `hep-research-mcp` `0.3.0` 的 MCP `listTools` 结果（见 inventory）：

- `standard` 模式：共 **72** 个工具
  - `hep_*`：45
  - `inspire_*`：12
  - `zotero_*`：7
  - `pdg_*`：8
- `full` 模式：共 **84** 个工具（在 `standard` 基础上额外暴露更多细粒度/高级工具）

### 2.1 文献与发现（INSPIRE）

能力：
- 结构化检索（query/operator）
- 论文/引用/被引/作者/机构等访问
- arXiv 源文件下载（LaTeX/PDF）与元数据获取
- 主题分析、citation network、field survey 等更高层工具

对 ingest / reproduce / derivation_check 的意义：
- ingest 的主数据源（稳定锚点）
- reproduce workflow 的“引用链扩展与最近工作定位”

### 2.2 写作证据与导出（Evidence-first writing）

能力：
- run/project 级证据索引、写作证据包、LaTeX evidence catalog、citation mapping
- paper scaffold/export（RevTeX）

对 revision / publication-export 的意义：
- 把“写作”变成 evidence-first 资产（可追溯、可导出、可共享）

### 2.3 项目/运行资产管理

能力：
- project/run 创建、artifact staging/read chunk、集成与导出等

对 Orchestrator 的意义：
- 未来可以用作 run ledger/资产归档的底层实现之一（当前我们先在本 repo 内用 `team/` 与 `artifacts/`）

### 2.4 Zotero 与 PDG

- Zotero：已启用（本机 Local API）
- PDG：当前未配置（需要 `PDG_DB_PATH` 等）

对用户的现实影响：
- “可对外用”时，PDG 相关能力需要明确安装/配置步骤，否则应在 UI 中显示为不可用

## 3) 我们想做的 agent 功能：哪些已有、哪些缺

下表以“面向用户的能力”来对照：

| 用户能力 | 现有组件是否覆盖 | 备注/缺口 |
|---|---:|---|
| 多角色分工 + 独立复核收敛 | 部分覆盖 | `research-team`/`review-swarm` 已有；但需 Orchestrator 把多角色作为默认内置 |
| 文献自动搜索 + 阅读笔记 | 部分覆盖 | MCP 能抓取；还缺“批处理 ingestion runner + 模板化 note + coverage matrix 自动更新” |
| “新意评估”报告 | 部分覆盖 | 可做 evidence-backed `LIKELY KNOWN / POSSIBLY NOVEL / UNCLEAR`；需要 workflow 与评测防幻觉 |
| 自动推导/一致性检查 | 部分覆盖 | `hep-calc` 提供计算底座；还缺“checker 优先”的推导分解与验证策略 |
| 自动写代码 + 数值计算 | 部分覆盖 | 需要 Orchestrator + approval gates + artifacts contract + eval suite |
| 自动复现论文主结果 | 部分覆盖 | `hep-calc` + MCP 支持；还缺“差异归因模板 + 复现目标抽取/定义 + 预算控制” |
| 自动审稿 | 覆盖 | `prl-referee-review` + `review-swarm` 可做文本审阅；仍需与“可编译/证据/引用”门禁联动 |
| 自动改稿 | 部分覆盖 | `research-writer` 提供写作侧工具；还缺“改稿闭环状态机 + diff/rollback + compile gate” |
| pause/resume/status/approve | 覆盖 | Orchestrator CLI/Web 已实现（见 `docs/ORCHESTRATOR_INTERACTION.md`；入口：`hep-autoresearch status/pause/resume/approve`） |
| 自我进化（L1–L3） | 部分覆盖 | EVOLUTION v0 已落地：从失败 run 生成 A2-gated 改进提案 + 回归锚点；更高自治的 L2/L3 仍需在 eval suite/回滚成熟后逐步放开 |

## 4) 是否需要额外开发新的 skills？

短期结论：**不一定需要**。现有 skills 已覆盖关键流程的“强门禁与复核”（research-team/review-swarm）与“计算/写作流水线”（hep-calc/research-writer）。

更重要的新增代码更可能放在本项目（`toolkit/` / `src/`）里：
- Orchestrator CLI/Web
- ingest runner / reproduce runner / revision runner
- eval runner（读 `evals/` 并执行验收）

如果要新增 skill，建议只在以下情况下做：
- 你希望把 Orchestrator 作为可复用“通用工作流 skill”（跨项目复用）
- 或者希望把“capability audit + dual review + convergence”固化成一键脚本（减少重复）

## 5) 是否需要新增/修改 hep-research-mcp 工具？

短期结论：**可以先不改 MCP**（用现有 MCP + 本地脚本即可），先把 Orchestrator 与 eval suite 做出来。

中期（对外可用时）可能需要的 MCP 扩展方向（可选）：
- 更安全的 sandboxed runner（把高风险执行封装成受控工具，减少“shell 全权”）
- LaTeX compile gate / diff gate / approval gate 的标准化接口（跨前端一致）
- project/run 资产与本 repo 的 `team/`、`artifacts/` 做更紧密绑定（减少双轨）

## 6) 为什么要做“我们的 agent”，而不是直接用 Codex/Claude Code/Gemini？

优势（做我们自己的 agent 平台）：
- 把科研正确性机制产品化：多角色分工、证据链、可复现产物、收敛门禁、回归评测
- 模型可替换：Codex/Claude/Gemini 都只是后端，大脑可换但流程与证据不变
- 对外可用：统一的安全策略与同意点（approve gates）、可暂停恢复、可审计 ledger

劣势/成本：
- 工程复杂度与维护成本显著高于“直接用现成 agent”
- 需要持续建设 eval suite（否则自我进化与迭代都不可控）
- 多角色与双模型复核有成本（但这是科研可靠性的成本）

折中建议：
- 我们不与 Codex/Claude/Gemini 竞争“模型能力”，而是把它们当可插拔执行器
- 价值在于：**把科研 workflow 变成可审计、可回归、可复核的系统**

## 7) 文献借鉴（agents/LLM workflow）

除工具能力盘点外，我们也从 curated 的 agent / research-workflow literature notes 中抽取了可执行机制，并给出“adopt now / later”的集成建议：
- `docs/AGENT_LITERATURE_INTEGRATION.md`
