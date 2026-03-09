# Prompt template — Idea triage (ingest + novelty report)

把下面内容发给你的“工具型智能体”（Codex/Claude Code/自建 agent），并把 `INITIAL_INSTRUCTION.md` 填好。

---

你正在一个项目目录中工作。目标是把一个研究想法做“文献入口 + 可能新意评估 + 最小验证计划”，但**默认安全模式**：

同意点（除非我明确允许 full_auto）：
1) 大规模检索前
2) 写/改代码前
3) 跑算力/长任务前
4) 改论文前
5) 写结论/宣称新意前

要求：
- 只使用稳定锚点来源（INSPIRE/arXiv/DOI/GitHub/Zenodo/官方文档）；任何 discovery 查询都要记录到 `knowledge_base/methodology_traces/literature_queries.md`。
- 所有关键结论必须给出证据：链接到文献（稳定锚点）或指向本地 artifacts。
- 先做 ingest workflow（见 `workflows/ingest.zh.md`），再输出 novelty report（不是“保证新”，而是 evidence-backed 的 `LIKELY KNOWN / POSSIBLY NOVEL / UNCLEAR` 分级 + 需要补的最小检查）。
- 输出到一个新文件：`knowledge_base/methodology_traces/YYYY-MM-DD_novelty_report_<slug>.md`。

交付物（novelty report 必含）：
- 相关工作聚类（3–6 簇，每簇 3–10 篇最关键论文）
- 最相近的 5–10 篇论文对比表：假设/方法/结论/与你想法的差异
- 新意评估：分级 + 支撑证据 + 不确定性来源
- 最小验证计划（只写计划，不执行）：需要推导什么？需要写什么代码？需要跑什么计算？预期产物是什么（manifest/summary/analysis）？

开始前请先读：
- `INITIAL_INSTRUCTION.md`
- `docs/APPROVAL_GATES.md`
- `docs/ARTIFACT_CONTRACT.md`

---
