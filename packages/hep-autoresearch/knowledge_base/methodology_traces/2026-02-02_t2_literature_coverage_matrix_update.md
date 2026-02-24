# Methodology trace — T2 literature coverage matrix update (2026-02-02)

Goal: 补齐 [PREWORK.md](../../PREWORK.md) 的 literature coverage matrix（至少 8–10 个稳定锚点来源），用于：
- 约束 agent 设计空间（避免重复造轮子/遗漏关键 prior work）
- 为“想法 → 文献 → 现状/新意 → 推进”工作流提供可审计的基础
- 把后续的 eval suite（回归评测）与门禁（approval gates）绑定到已知方法/基准

## Sources and query notes (stable anchors preferred)

本次补齐主要复用并扩展了已有的 MadAgents references shortlist：
- [MadAgents agent literature survey (2026-02-01)](2026-02-01_madagants_agent_literature_survey.md)

补齐维度中的“通用 agent / eval / 安全 / RAG”部分时，优先选取 arXiv 稳定锚点并写入 KB：
- AgentBench (arXiv:2308.03688)
- SWE-bench (arXiv:2310.06770)
- AutoGen (arXiv:2308.08155)
- Reflexion (arXiv:2303.11366)
- Tree of Thoughts (arXiv:2305.10601)
- RAG (arXiv:2005.11401)
- Agent-SafetyBench (arXiv:2412.14470)
- Survey on Evaluation of LLM-based Agents (arXiv:2503.16416)

> 说明：为保证可复现性，本次以“直接 arXiv id 输入”为主（由 W1 ingestion 落盘），而不是把关键词检索作为 SSOT。

## Outputs (what was updated)

1) Coverage matrix updated:
- [PREWORK.md](../../PREWORK.md)

2) KB notes added/confirmed:
- [arxiv-2005.11401-rag](../literature/arxiv-2005.11401-rag.md)
- [arxiv-2210.03629-react](../literature/arxiv-2210.03629-react.md)
- [arxiv-2302.04761-toolformer](../literature/arxiv-2302.04761-toolformer.md)
- [arxiv-2303.11366-reflexion](../literature/arxiv-2303.11366-reflexion.md)
- [arxiv-2305.10601-tree-of-thoughts](../literature/arxiv-2305.10601-tree-of-thoughts.md)
- [arxiv-2308.00352-metagpt](../literature/arxiv-2308.00352-metagpt.md)
- [arxiv-2308.03688-agentbench](../literature/arxiv-2308.03688-agentbench.md)
- [arxiv-2308.08155-autogen](../literature/arxiv-2308.08155-autogen.md)
- [arxiv-2310.06770-swe-bench](../literature/arxiv-2310.06770-swe-bench.md)
- [arxiv-2405.15793-swe-agent](../literature/arxiv-2405.15793-swe-agent.md)
- [arxiv-2412.14470-agent-safetybench](../literature/arxiv-2412.14470-agent-safetybench.md)
- [arxiv-2503.16416-agent-eval-survey](../literature/arxiv-2503.16416-agent-eval-survey.md)
- [recid-3112995-madagants](../literature/recid-3112995-madagants.md)
- [recid-3093880-heptapod](../literature/recid-3093880-heptapod.md)
- [recid-3090360-llm-powered-hep-agents](../literature/recid-3090360-llm-powered-hep-agents.md)
- [recid-3062816-argoloom](../literature/recid-3062816-argoloom.md)
- [recid-2968660-agents-of-discovery](../literature/recid-2968660-agents-of-discovery.md)

## Follow-ups (not done here)

- 深读（精读）优先级建议：
  - 对“评测/门禁”最关键：AgentBench、SWE-bench、Agent-SafetyBench（用来定义我们自己的 eval case 形态）
  - 对“检索+证据链”最关键：RAG（用来澄清 evidence-first 的可实现边界）
  - 对“多角色编排”最关键：AutoGen、MetaGPT（用来抽象出可复用的编排原语）
