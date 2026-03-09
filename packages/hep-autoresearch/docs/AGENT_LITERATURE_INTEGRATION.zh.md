# Agent literature integration（从 curated 的 agent / research-workflow literature notes 提炼可执行机制）

目的：把 “agent 相关文献” 的优点转化为我们 autopilot 的**可实现机制**（流程/门禁/产物/评测），而不是停留在概念层面。

数据来源：
- curated profile：[`knowledge_base/_index/kb_profiles/curated.json`](../knowledge_base/_index/kb_profiles/curated.json)
- 代表性 KB notes：
  - [@arxiv-2210.03629-react](../knowledge_base/literature/arxiv-2210.03629-react.md)
  - [@arxiv-2303.11366-reflexion](../knowledge_base/literature/arxiv-2303.11366-reflexion.md)
  - [@arxiv-2405.15793-swe-agent](../knowledge_base/literature/arxiv-2405.15793-swe-agent.md)
  - [@arxiv-2305.13971-grammar-constrained-decoding](../knowledge_base/literature/arxiv-2305.13971-grammar-constrained-decoding.md)
  - [@arxiv-2310.06770-swe-bench](../knowledge_base/literature/arxiv-2310.06770-swe-bench.md)

## 1) 我们已经“集成/对齐”的关键点（不是新增负担）

这些理念在我们现有设计里已经落地（或已经写成硬契约）：

- **多角色分工 + 独立复核**（对应 multi-agent debate / MetaGPT 思路）
  - 默认 Planner/Executor/Reviewer，Reviewer packet-only + escalation（见 [Reviewer isolation](REVIEWER_ISOLATION.md)）
- **工具增强 + 可审计轨迹**（对应 ReAct / TALM / Toolformer 的“工具输出=证据”）
  - 我们把 MCP/计算器当作“手脚”，关键输出必须落到 artifacts 指针
- **可恢复状态机 + 同意点**（科研场景的现实约束）
  - [Orchestrator state](ORCHESTRATOR_STATE.md) + [Approval gates](APPROVAL_GATES.md)
- **评测驱动的策略/代码演化（L1–L3）**
  - [Eval gate contract](EVAL_GATE_CONTRACT.md) + anti-gaming/bypass 用例

## 2) 从文献“新增”出来的高 ROI 机制（建议纳入 M1–M2 设计）

### 2.1 run-card / job spec（结构化执行契约）

来源：
- [@arxiv-2210.03629-react](../knowledge_base/literature/arxiv-2210.03629-react.md)
- [@arxiv-2405.15793-swe-agent](../knowledge_base/literature/arxiv-2405.15793-swe-agent.md)

建议集成：
- 把每次复杂 workflow 的关键配置固化为结构化 run-card（类似 `hep-calc` job），并纳入 artifacts manifest。

### 2.2 deterministic runner 保证执行边界 + agent 负责生成/修错

来源：
- [@arxiv-2405.15793-swe-agent](../knowledge_base/literature/arxiv-2405.15793-swe-agent.md)
- [@arxiv-2210.03629-react](../knowledge_base/literature/arxiv-2210.03629-react.md)

建议集成：
- 将“确定性执行器（workflow manager / runner）”作为默认执行层；agent 不直接掌控“随意执行”，而是提交受控任务。
- 把 success rate / error distribution / cost / API calls 做成标准化指标写入 ledger（用于回归评测与稳定性分析）。

### 2.3 结构化输出的硬约束（Grammar-constrained decoding 方向）

来源：
- [@arxiv-2305.13971-grammar-constrained-decoding](../knowledge_base/literature/arxiv-2305.13971-grammar-constrained-decoding.md)

建议集成：
- 对关键结构化输出（gate 决策、review 报告、revision plan、artifact pointers）优先使用 JSON mode / constrained decoding（若 runner 支持），否则严格 schema 校验 + fail-fast + retry。

### 2.4 代码修改的“受限行动空间”（SWE-agent 方向）

来源：
- [@arxiv-2405.15793-swe-agent](../knowledge_base/literature/arxiv-2405.15793-swe-agent.md)

建议集成：
- A2（code changes）默认采用“patch plan → apply diff → run minimal verification”的固定流程；并把每次失败尝试沉淀为 autopatch 经验库（L3）。

### 2.5 ACI 设计原则：actions/feedback/guardrails（SWE-agent 方向；对“人类可读产物”也适用）

来源：
- [@arxiv-2405.15793-swe-agent](../knowledge_base/literature/arxiv-2405.15793-swe-agent.md)

建议集成（对 Orchestrator UX + artifacts 设计是硬约束）：
- actions 需要 **简单易懂**、**紧凑高效**（避免 agent 组合一堆碎动作才完成一个操作）。
- environment feedback 需要 **信息量高但简洁**（避免把 token/注意力预算浪费在噪声上）。
- guardrails 必须默认打开（语法/结构校验、schema 校验、fail-fast + retry），抑制错误传播并加速恢复。

对应到本项目已经落地的一个例子：`report.md`（由 JSON SSOT 确定性渲染）就是“给人类/agent 的简洁反馈层”，用于快速定位“跑了什么/结果是什么/看哪里”。

### 2.6 不训练模型也能变强：episodic memory + verbal reinforcement（Reflexion 方向）

来源：
- [@arxiv-2303.11366-reflexion](../knowledge_base/literature/arxiv-2303.11366-reflexion.md)

建议集成（L3 自我进化的主干机制之一）：
- 把每次失败（review/eval/复现/构建失败）转成“可执行反思条目”写入经验库（episodic memory）。
- 经验库条目必须与 eval case 绑定，支持回滚/消融/灰度启用，防止错误经验固化。

### 2.7 显式 backtracking / branch checkpoints

来源：
- [@arxiv-2210.03629-react](../knowledge_base/literature/arxiv-2210.03629-react.md)
- [@arxiv-2303.11366-reflexion](../knowledge_base/literature/arxiv-2303.11366-reflexion.md)

建议集成（Later；但需要先把接口与评测准备好）：
- 将复杂任务中的“试错 / 回退 / 改写下一步”显式化为 checkpoint 或 branch（而不是只保留线性日志），避免 runtime 被单一路径绑死。
- 引入 node 级别的“继承摘要 + RAG 背景 + 执行 + critique + 下一步”闭环，但必须绑定：
  - 可恢复状态（resume）
  - 评测回归（防 reward hacking）
  - 回滚/消融（防错误经验固化）

### 2.8 三层知识库的显式语义

说明：
- 这一节不是照搬单篇论文，而是把现有 `literature / methodology_traces / priors` 三层结构收束成稳定语义，避免后续实现继续把临时 planning/context 混进长期 KB。

建议集成（Adopt now：仅做语义对齐 + 文档化；Later：做接口）：
- Adopt now：明确我们现有结构的三层语义：
  - `knowledge_base/literature/` → Library
  - `knowledge_base/methodology_traces/` + `EVOLUTION` proposals → Methodology
  - `knowledge_base/priors/` → Priors
- Later：做一个最小 “KB index” 接口（可导出为 JSON），用于：
  - Orchestrator 的任务分派（按 layer 取证据）
  - reviewer packet 的证据束自动化
  - 经验库条目的可检索/可回滚/可消融

### 2.9 运行质量指标 + prompt 作为 run-card 参数（SWE-agent 方向）

来源：
- [@arxiv-2405.15793-swe-agent](../knowledge_base/literature/arxiv-2405.15793-swe-agent.md)

建议集成（Adopt now）：
- 把运行指标（calls/tool calls/errors/latency/tokens/cost）作为 artifacts 的标准字段，并纳入 eval（稳定性/方差，不只是 pass/fail）。
- 把 prompt（含 tool list 与关键约束）当作 run-card 字段固定落盘，避免“换了 prompt 但没记录”造成不可复现。

### 2.10 多域模块 + curated KB（少而精）+ 交付物导向

说明：
- 这一节强调的是产品边界：默认 seed KB 要保持少而精，产物以 run cards / configs / logs 为主，而不是继续把偶发实例或临时调研堆进 package repo。

建议集成（Adopt now / later）：
- Adopt now：
  - 明确每个 domain module 的输入/输出边界，并把“可复跑交付物”（run cards/config/scripts/logs）作为默认产物，而不是只输出文字结论。
- Later：
  - 提供 `--kb-profile=curated|minimal|user` 的 KB 模式，支持“少而精”语料降低噪声；用 eval 约束扩库带来的收益/风险。

## 3) 对我们来说“应谨慎/后置”的点

- “自我修改/自我进化”必须以 eval suite 与回滚为前提：先做可测，再谈更高自治（见 [Eval gate contract](EVAL_GATE_CONTRACT.md)）。
- 任何“新意/结论”输出必须走 A5 gate（避免把文献缺失当成新意、把随机波动当成发现）。

## 4) 我们与已有 agent 框架的关键不同

下面这些“不同”不是口号，而是已经写入契约/实现、并可被回归评测约束的：

1) **Artifacts 三件套（JSON SSOT）+ 指针引用**
   - `manifest.json / summary.json / analysis.json` 是唯一真源（SSOT），任何 headline/结论必须能指向稳定 JSON pointer。
2) **人类可读视图是派生物（防止文档漂移）**
   - `report.md` 由 JSON 确定性渲染，可丢弃可重建，用于审阅与快速定位（见 [Artifact contract](ARTIFACT_CONTRACT.md)）。
3) **默认同意点（科研现实约束）**
   - 大规模检索/写代码/跑算力/改稿/写结论前默认要求人类同意（除非显式开启全自动），并且这些 gate 是可审计的状态机节点（见 [Approval gates](APPROVAL_GATES.md)）。
4) **多角色不是“可选”，而是质量控制的内置结构**
   - Reviewer packet-only + 隔离执行面，减少提示注入与“看过执行痕迹后自洽”的风险（见 [Reviewer isolation](REVIEWER_ISOLATION.md)）。
5) **开发流程也走门禁：Opus+Gemini 双评审**
   - 每个开发里程碑 commit 前必须 dual review 收敛，并把产物写入 [artifacts/](../artifacts/)，防止“局部最优修补”破坏全局目标（见项目根目录 [AGENTS.md](../AGENTS.md)）。

## 5) 深读优先（设计 agent 本身也是研究）

经验原则（需要固化到流程/门禁，而不是靠记忆）：
- 在宣称“新意”或推进高成本工作流之前，必须对最接近 prior work 的关键文献做 TeX 级精读，并把可执行机制提炼进 KB（见 [knowledge_base/literature/](../knowledge_base/literature/)）与本项目契约/工作流。

执行提示（避免重复造轮子）：
- arXiv 论文可按需下载 TeX 源码（物化时可用 `references/arxiv_src/<id>/src/` 这类布局作为临时约定），再做精读/摘录到 KB note；不要把整棵源码树长期沉积在 package repo 里。
- 若该论文在 INSPIRE 上不存在，也可以直接用 arXiv Atom + e-print 源（`export.arxiv.org` + `arxiv.org/e-print/<id>`）抓取并落盘；抓取动作要记到 `knowledge_base/methodology_traces/literature_queries.md`。
