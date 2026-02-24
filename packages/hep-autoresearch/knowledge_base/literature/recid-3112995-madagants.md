# MadAgents — Plehn, Schiller, Schmal (2026)

RefKey: recid-3112995-madagants
INSPIRE recid: 3112995
Citekey: Plehn:2026gxv
Authors: Plehn et al.
Publication: arXiv:2601.21015 [hep-ph]
Links:
- INSPIRE: https://inspirehep.net/literature/3112995
- arXiv: https://arxiv.org/abs/2601.21015
- Code: https://github.com/heidelberg-hepml/MadAgents
- TeX snapshot (local): [main.tex](../../references/arxiv/2601.21015/source/main.tex)

## 为什么与本项目高度相关

这篇文章把“工具使用 + 多代理编排 + 门禁/约束 + 可复现实验环境”落到了 MadGraph 生态：
- 从安装/教学/用户支持扩展到“从论文 PDF 出发的自动化模拟活动（simulation campaign）”。
- 明确区分控制代理（Orchestrator/Planner/Reviewer 等）与工作代理（MG 操作、脚本、绘图、PDF 读取、网页检索等），并强调上下文限制与工具调用循环。

## 可复用的结构要点（抽象层面）

1) **控制代理 vs 工作者代理**：把“计划/复核/编排”与“执行”分离，降低幻觉与错误传播。
2) **工具调用循环（plan→act→observe→revise）**：把工具输出视为一等公民，允许自动纠错与迭代。
3) **容器化环境**：把“能跑”变成默认，减少环境差异带来的不可复现。
4) **面向任务的角色化提示词**：对 MG-Operator/Plotter/PDF-Reader 等给出明确工具使用与行为约束。

## 可复用的结构要点（可执行层面；来自 TeX 精读）

### 1) Plan / Plan-Updater 的结构化协议

要点：
- Planner 产出的计划步骤带有：ID/title/description/rationale/depends on/status/outcome。
- Plan-Updater 只输出“对已有 plan 的更新列表”（覆盖 status/outcome），并由系统代码自动刷新 blocked/pending。

这给了我们一个很直接的启发：计划不是“给人看的文本”，而是一个可以被门禁/回归/恢复系统消费的结构化对象。

### 2) Summarizer 的“上下文预算管理”

要点：
- 超过阈值后对最老消息做摘要，同时保留最近非工具输出消息，并确保 tool call 与 tool output 成对保留。
- 摘要被附加到 agent instructions，降低长任务的遗忘与漂移。

### 3) 工具清单 + 使用指导作为提示词的一部分

要点：
- 对 tool-calling agents 提供 tool_list + tool_usage_guidance（例如：优先 apply_patch 修改文件；交互式 CLI 用于 debug 但最终逻辑应固化为脚本；长任务超时用 wait 等）。
- 显式给出环境描述与关键目录（/workspace, /output, /opt, PDF read-only 目录等），并强调“不要直接改 transcript 文件”。

## 对我们“全流程科研自动化”的启发

- 他们的重点是 MadGraph 生态；我们要把同样的“系统形态”推广到 HEP 更广的研究链条：
  - 文献入口（INSPIRE/arXiv）→ 证据/笔记
  - 推导/一致性检查（CAS + 约束）
  - 数值/复现（可审计 artifacts）
  - 写作/审稿/改稿闭环（LaTeX + 引用/证据门禁）

## 需要批判性对待/进一步核查的点

- “从论文自动复现”在真实科研里经常遇到隐含假设（参数、截断、软件版本、随机数种子、拟合/重建细节）。我们必须把这些作为强制记录项写入产物契约，否则复现不可控。
- 多代理系统的可靠性高度依赖门禁与评测：必须用 eval suite 做回归，避免“能跑 demo 但不可持续”。

## 参考文献中与 agents/LLM 直接相关的条目（我们已做 KB notes）

来源：本项目对 MadAgents references 的抽取与筛选见 trace：
- [MadAgents agent literature survey (2026-02-01)](../methodology_traces/2026-02-01_madagants_agent_literature_survey.md)

已沉淀为 KB notes（精选）：
- [@recid-3093880-heptapod](recid-3093880-heptapod.md)
- [@recid-3090360-llm-powered-hep-agents](recid-3090360-llm-powered-hep-agents.md)
- [@recid-3062816-argoloom](recid-3062816-argoloom.md)
- [@recid-2968660-agents-of-discovery](recid-2968660-agents-of-discovery.md)
- [@arxiv-2210.03629-react](arxiv-2210.03629-react.md)
- [@arxiv-2405.15793-swe-agent](arxiv-2405.15793-swe-agent.md)
- [@arxiv-2305.13971-grammar-constrained-decoding](arxiv-2305.13971-grammar-constrained-decoding.md)

Verification status: deep-read (TeX snapshot; 架构/协议层已核查；端到端复现实验仍待复跑)
What was checked:
- agent 结构：控制代理/工作代理划分与职责
- 文章目标：用户支持 + 自动化 simulation campaign 的定位
- Plan/Plan-Updater 的结构化字段与 blocked/pending 更新策略
- Summarizer 的上下文预算与“tool call/输出成对保留”策略
- tool_list + tool_usage_guidance + 环境描述（目录/交互 CLI transcript 约束）
