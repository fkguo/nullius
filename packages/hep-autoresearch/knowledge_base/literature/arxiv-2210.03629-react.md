# ReAct — Yao et al. (2022)

RefKey: arxiv-2210.03629-react
arXiv: 2210.03629 [cs.CL]
Links:
- arXiv: https://arxiv.org/abs/2210.03629
- TeX snapshot (local): [abstract.tex](../../references/arxiv/2210.03629/source/iclr2023/text/abstract.tex)

## 为什么与本项目相关

ReAct 把 agent 的核心循环明确成“Reasoning（推理）↔ Acting（行动/工具调用）”的交织轨迹。这与我们要做的科研自动化（plan→act→observe→revise）几乎是同一个抽象：把工具输出当作一等公民，用观测来纠错与推进。

## 可借鉴的创新点（可执行层面；来自 TeX 精读）

1) **Thought/Action/Observation 的显式轨迹**
   - 为后续审计、回放、失败归因提供结构。
2) **把“工具调用”纳入推理流程**
   - 不是“先想完再调用工具”，而是逐步调用、逐步修正。
3) **降低 hallucination / error propagation 的机制**
   - 通过与外部知识库/环境交互（论文示例：Wikipedia API），把“可验证的观测”注入推理链条。
4) **安全视角：受限行动空间**
   - 论文 Ethics Statement 明确强调：与外部环境交互存在风险，因此在实验中限制可访问网站与动作空间。

## 对我们设计的直接映射

- 对应到本项目的 Orchestrator：把每步动作的输入/输出落盘（ledger + artifacts），并支持 pause/resume。
- 对应到评测：把轨迹拆成可回归 eval（例如“是否在需要证据时调用了检索/对照工具，而不是凭空断言”）。
- 对应到安全与可控性：默认采用受限 action space（受控工具 + schema 校验 + approval gates），而不是“任意命令执行”。

Verification status: deep-read (TeX snapshot; 摘要 + reproducibility/ethics 立场已核查)
What was checked:
- 摘要：interleaved reasoning+acting 的动机、任务设置与“减少幻觉”的机制描述
- Ethics：与外部环境交互风险 → 需要受限行动空间（与我们 approval/工具门禁对齐）
