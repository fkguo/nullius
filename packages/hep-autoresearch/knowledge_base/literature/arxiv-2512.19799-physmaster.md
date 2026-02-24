# PhysMaster — Miao et al. (2025)

RefKey: arxiv-2512.19799-physmaster
arXiv: 2512.19799 [cs.AI]
Links:
- arXiv: https://arxiv.org/abs/2512.19799
- TeX snapshot (local): [main.tex](../../references/arxiv_src/2512.19799/src/main.tex)

## 为什么与本项目相关

PhysMaster 试图把 “理论推导 + 数值计算 + 文献检索 + 长任务探索” 组合成一个端到端 physics agent，并明确提出了：
- 三阶段工作流：Pre-Task → Task Execution → Post-Task（从 query 到 report）
- long-horizon 的 context/进度管理方法（MCTS + 分层角色）
- 三层知识库 LANDAU：Library / Methodology / Priors，并强调会随任务不断积累与“自我进化”

这些点与我们要把科研流程工程化（同意点、可恢复状态机、证据链、经验库、自我进化）高度同构，是一个需要明确对照、吸收优点、并指出差异点的关键 prior work（虽不在 INSPIRE）。

## 可借鉴的创新点（可执行层面；来自 TeX 精读）

1) **Query → 结构化任务的 Clarifier**
   - 抽取 task type、物理约束、子任务序列，降低“自然语言含糊 + token 预算膨胀”导致的漂移风险。
2) **双路检索：Quick Thinker + Reasoner**
   - 一个偏广覆盖扩展，一个偏语义过滤；强调从每篇 paper 抽取定性/定量知识用于后续 critic/建模。
3) **MCTS 作为 long-horizon 的调度骨架**
   - 把子任务映射为 node，并在 node 内做“继承摘要 + RAG 背景 → 执行 → 评价/奖励 → 生成下一步”，用 UCT 平衡探索/利用。
4) **LANDAU（Library/Methodology/Priors）作为长期记忆结构**
   - 每个成功任务把本地文献库并入全局库；把“验证过的推理轨迹/技术细节”提炼成可复用 Methodology 条目（类似 episodic memory + 方法卡片）。

## 对我们设计的直接映射（adopt now / later）

- Adopt now（设计对齐 + 低成本增量）：
  - 将我们的 [knowledge_base/](../) 显式对齐为 LANDAU 三层视角（对应：literature=Library，methodology_traces+evolution=Methodology，priors=Priors），并在 [EVOLUTION.md](../../docs/EVOLUTION.md) / [ARCHITECTURE.md](../../docs/ARCHITECTURE.md) 中说明这种映射。
  - 将 Clarifier 的输出字段（task type / constraints / subtask sequence）固化为结构化 schema（与 T29 Plan/Plan-Updater 一起做）。
- Later（需要更多工程与评测支撑）：
  - 引入 “search tree + reward” 的 long-horizon 轨迹结构：把 eval 通过率/门禁结果作为 reward，用于自动选择更有希望的分支（必须绑定回归评测与回滚，避免 reward hacking）。
  - 将 “Quick Thinker / Reasoner” 做成 W1 的可选 mode（先扩展候选，再做严格过滤），并把过滤/覆盖率指标写入 eval。

## 我们与 PhysMaster 的关键不同（需要显式写进设计）

- 我们把 **默认同意点**（大规模检索/写代码/跑算力/改稿/写结论）作为状态机硬门禁；PhysMaster 的论文叙述更偏系统展示，未把“人类监督点”工程化成强制交互契约。
- 我们把 **artifact 三件套（JSON SSOT）+ 指针引用** 作为所有结论的证据锚点，report.md 只是派生视图；LANDAU 的理念类似，但我们的“证据契约 + 回归 eval”更强制。

Verification status: deep-read (TeX snapshot; 架构/调度/MCTS/LANDAU 已核查)
What was checked:
- `main.tex`：Architecture and Workflow（Pre-Task / MCTS / LANDAU）与 Discussion
