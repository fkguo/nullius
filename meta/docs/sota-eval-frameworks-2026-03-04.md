# SOTA Survey — Eval Frameworks for NEW-RT-05 (2026-03-04)

## Scope

调研目标：为 Phase 3 Batch 8（NEW-RT-05）选择 eval framework 实现路径，覆盖 fixture schema、runner、metrics、baseline、reporting。

## Sources (official docs / primary repos)

- Promptfoo docs: https://www.promptfoo.dev/docs/usage/eval-setup/
- Promptfoo assertions: https://www.promptfoo.dev/docs/configuration/expected-outputs/
- DeepEval repo: https://github.com/confident-ai/deepeval
- Braintrust docs: https://www.braintrust.dev/docs/start/eval-sdk
- LangSmith docs: https://docs.langchain.com/langsmith/evaluation-concepts
- OpenAI eval best practices: https://platform.openai.com/docs/guides/evals

## Findings

1. **Promptfoo**
   - 强项：YAML/fixture 驱动、assertion 体系完整、适合 prompt/LLM response 评测。
   - 局限：与本仓库的 MCP tool-level local eval（vitest + run artifacts）融合成本高。

2. **DeepEval**
   - 强项：pytest 集成成熟，适合 LLM output 质量指标扩展（尤其 LLM-as-judge）。
   - 局限：主路径偏 Python 生态，与当前 TS/vitest 主线不一致。

3. **Braintrust / LangSmith**
   - 强项：dataset + scorer + experiment trace + baseline 历史管理成熟。
   - 局限：偏在线平台/SDK 工作流；本批次目标是 repo 内本地 deterministic harness（fixture-first、offline-friendly）。

4. **OpenAI eval best practices**
   - 推荐分层 eval 体系（unit/smoke/regression）。
   - 强调“先人工建立 golden set，再自动化”，并持续维护基线与回归阈值。

## Decision

**采用“自建轻量 TS eval framework + 借鉴行业模式”**，而非直接引入外部框架。

- 直接复用外部框架不满足本项目的关键约束：`vitest` 集成、MCP tool-call 路径、artifact URI/evidence-first 输出。
- 本批次实现中借鉴了 SOTA 共识：
  - fixture-driven eval set（Promptfoo/LangSmith）
  - 可扩展 metric 函数接口（DeepEval）
  - baseline 对比与 delta 分析（Braintrust/LangSmith）
  - 分层评测与回归守护（OpenAI best practices）
