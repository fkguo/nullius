# HEPTAPOD — Menzo et al. (2025)

RefKey: recid-3093880-heptapod
INSPIRE recid: 3093880
arXiv: 2512.15867 [hep-ph]
Links:
- INSPIRE: https://inspirehep.net/literature/3093880
- arXiv: https://arxiv.org/abs/2512.15867
- TeX snapshot (local): [orchestrating_HEP.tex](../../references/arxiv/2512.15867/source/orchestrating_HEP.tex)

## 为什么与本项目相关

这篇工作明确把“LLM 编排 + HEP domain tools + 可审计层”作为一个框架问题来做，目标与我们几乎同构：把 LLM 放在工具与算力之间，做到可追溯、可控、可复现、可人类介入。

## 可借鉴的创新点（可执行层面；来自 TeX 精读）

1) **run-card-driven configuration**
   - 把复杂 workflow 的关键配置固化成 run-card（结构化配置），降低“对话漂移”。
2) **schema-validated operations**
   - 对工具调用/输入输出做 schema 校验，减少自由文本导致的不确定性与注入面。
3) **structured + auditable layer**
   - 明确强调“人类研究者 ↔ LLM ↔ 计算基础设施”之间需要可审计的中间层。

## 结构细节（用于“可实现机制”提炼）

### 1) Schema-validated tools（runtime fields vs state fields）

要点：
- 每个能力暴露为 tool（Python class），输入/输出由 JSON schema 定义并在执行前做校验。
- schema 明确区分：
  - runtime fields：agent 提供的“科学/程序自由度”（参数、相对路径、配置等）
  - state fields：编排层注入的环境信息（workspace 路径、默认值、来自上一阶段的元数据等），对 agent 不可见

### 2) Tool docstring 作为“语义接口”（schema + docstring 配合）

要点：
- schema 决定“允许什么形状的输入/输出”，docstring 决定“为什么/何时使用这个 tool”。
- 输出也返回结构化 JSON，使得 docstring 能定义字段含义，便于 downstream 串联与审计。

### 3) LLM-friendly intermediate representation（evtjsonl）

要点：
- 引入 line-delimited JSON（JSONL）的事件格式，让中间产物既能被程序消费，也能在对话上下文中被 agent 直接检查。
- 同时提供到 NumPy/ML 框架的转换工具，避免牺牲分析端效率。

### 4) Orchestration vs scripting（为什么不是“写个脚本就够了”）

他们给出的（可复用的）差异点：
- intent-level 描述 + 动态重配置（不改底层脚本也能改 scan/分支/分析逻辑）
- structured error objects（而非纯日志）→ 更可自动恢复、更可审计
- provenance / trace（工具调用与输出形成机器可读轨迹）

## 对我们设计的直接映射（adopt now / later）

- Adopt now（M1–M2）：
  - 在 Orchestrator 层引入 “run-card / job spec” 的概念（与 `hep-calc` job、以及 MCP run manifest 对齐）。
  - 把“schema-validated tool calls”作为默认门禁（与我们的 `specs/` + token gate/approval gates 对齐）。
- Later：
  - 更强的 HEP workflow 工具链整合（例如对模拟链条给出标准组件接口）。

## 需要批判性对待/进一步核查

- 需要看它是否提供了可复现的端到端 demo（以及是否包含失败模式/恢复策略）。
- 我们的系统更强调 Reviewer 信息隔离与反投机 eval；需要对比其是否覆盖这些可靠性机制。

Verification status: deep-read (TeX snapshot; 重点核查架构/接口/可执行机制)
What was checked:
- 架构：agent ↔ sandboxed workspace ↔ tool execution engine 的分层描述
- tool 接口：schema-validated、runtime/state fields 区分、docstring+schema 作为“提示词+约束”
- run-card：作为协调边界、复现与透明性载体
- 中间数据：evtjsonl 的设计动机与与分析端互操作路径
