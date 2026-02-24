# AutoGen: Enabling Next-Gen LLM Applications via Multi-Agent Conversation — Wu et al.

RefKey: arxiv-2308.08155-autogen
arXiv: 2308.08155 [cs.AI]
Links:
- arXiv: https://arxiv.org/abs/2308.08155
- Code: https://github.com/microsoft/autogen
- TeX snapshot (local): [arxiv_main.tex](../../references/arxiv/2308.08155/source/arxiv_main.tex)

## Key points（来自 TeX 精读）

1) **多代理对话框架（multi-agent conversation framework）**
   - 用多个 agents 的对话来完成任务；agents 可基于 LLM、工具、人工，或混合。
2) **可编程的交互模式**
   - 对话模式既可用自然语言描述，也可用代码定义（框架层强调“模式可配置/可组合”）。
3) **工程定位：做一个“通用框架”，而非单一任务 agent**
   - 论文通过多领域示例展示有效性（数学、coding、QA、决策等）。
4) **Ethics statement 对风险点的清单化**
   - 讨论了隐私/偏见/可追责与透明性/用户信任/外部环境修改带来的潜在风险与 safeguard 需求。

## 对本项目的直接启发（可实现机制）

- 把“对话模式”抽象为可配置的 workflow（我们已有 `workflows/` + Orchestrator 状态机），但需要强制接入 artifacts 契约与 approval gates，防止“多代理对话漂移”。
- 他们在 ethics 里强调的风险点，提示我们：默认应走受限 action space + 可审计 ledger（并把高风险动作放到显式同意点）。

## Skepticism / checks to do（后续）

- 他们的“示例应用有效性”多数是 demo 风格：对我们来说需要做成可回归的 eval cases（失败模式/成本/稳定性）。
- 如果我们未来借鉴其 conversation patterns，需要明确：哪些模式在科研工作流中可测、可控、可复现。

Verification status: deep-read (TeX snapshot; 摘要+ethics 立场已核查；实验细节后续按需精读)
What was checked:
- 摘要：框架定位、agent 类型组合、可编程对话模式
- Ethics：风险点清单与 safeguard 需求（与本项目门禁设计相关）
