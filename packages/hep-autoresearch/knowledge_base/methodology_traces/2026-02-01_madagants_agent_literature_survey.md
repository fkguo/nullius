# Methodology trace — MadAgents references → agent literature shortlist (2026-02-01)

Goal: 从 [@recid-3112995-madagants](../literature/recid-3112995-madagants.md)（MadAgents, arXiv:2601.21015）出发，抽取其参考文献中与“LLM/agent/多代理/工作流编排/结构化输出”相关的条目，作为我们 autopilot 设计的可借鉴来源，并沉淀为 KB notes。

## Evidence / data sources

- INSPIRE record: https://inspirehep.net/literature/3112995
- References export (machine-readable):
  - [recid-3112995 references.json](../../references/inspire/recid-3112995/references.json)
  - [recid-3112995 references.md](../../references/inspire/recid-3112995/references.md)
- Extraction script:
  - [scripts/extract_inspire_references_from_recid.py](../../scripts/extract_inspire_references_from_recid.py)
- arXiv metadata for non-HEP agent papers:
  - [references/arxiv/arxiv_metadata.json](../../references/arxiv/arxiv_metadata.json)

## Selection heuristic (triage)

1) 对 MadAgents references 做 keyword tagging（agent/llm/tool/workflow/rag/eval_safety）。
2) 只把“明显与 agentic workflow / tool use / multi-agent 相关”的条目做成 KB note（避免把所有 HEP 工具链论文都拉进来）。
3) 优先顺序：
   - HEP 领域内“agentic HEP workflow”论文（能直接借鉴到我们的目标）
   - 通用 agent/tool-use 经典论文（可抽象成可执行机制）
   - 结构化输出/约束解码（直接服务于 schema-validated outputs）

> 注意：该 heuristic 会有漏检/误检；后续可按需要补齐，但每次补齐必须记录“为何加入”。

## Selected papers → KB notes

### HEP / fundamental-physics agentic workflow

- [@recid-3093880-heptapod](../literature/recid-3093880-heptapod.md)
- [@recid-3090360-llm-powered-hep-agents](../literature/recid-3090360-llm-powered-hep-agents.md)
- [@recid-3062816-argoloom](../literature/recid-3062816-argoloom.md)
- [@recid-2968660-agents-of-discovery](../literature/recid-2968660-agents-of-discovery.md)

### General agent/tool-use papers (from arXiv, not INSPIRE-indexed)

- [@arxiv-2210.03629-react](../literature/arxiv-2210.03629-react.md)
- [@arxiv-2205.12255-talm](../literature/arxiv-2205.12255-talm.md)
- [@arxiv-2302.04761-toolformer](../literature/arxiv-2302.04761-toolformer.md)
- [@arxiv-2405.15793-swe-agent](../literature/arxiv-2405.15793-swe-agent.md)
- [@arxiv-2308.00352-metagpt](../literature/arxiv-2308.00352-metagpt.md)
- [@arxiv-2305.14325-multiagent-debate](../literature/arxiv-2305.14325-multiagent-debate.md)
- [@arxiv-2305.13971-grammar-constrained-decoding](../literature/arxiv-2305.13971-grammar-constrained-decoding.md)

## Next step

把每篇 paper 的“可复用模式/可执行机制”汇总到设计文档，并明确：
- adopt now（M1–M2 可直接集成）
- later（需要更多基础设施/评测后再做）
- not needed（不适配我们的风险/成本结构）

