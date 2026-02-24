# Methodology trace — T28 agent literature deep-read (TeX-level) (2026-02-03)

Goal: 对最接近 prior work 的关键 agent 文献做 TeX 级精读，把“可执行机制”提炼进 KB，并更新集成建议文档（adopt-now/later + 差异点），避免停留在概念层面。

## Evidence / data sources (stable anchors + local TeX)

- PhysMaster (non-INSPIRE example):
  - arXiv: https://arxiv.org/abs/2512.19799
  - TeX snapshot (local): `references/arxiv_src/2512.19799/src/main.tex`
  - Atom metadata (local): `references/arxiv/2512.19799/metadata.json`
- Agents of Discovery:
  - INSPIRE: https://inspirehep.net/literature/2968660
  - arXiv: https://arxiv.org/abs/2509.08535
  - TeX snapshot (local): `references/arxiv_src/2509.08535/src/main.tex`
- ArgoLOOM:
  - INSPIRE: https://inspirehep.net/literature/3062816
  - arXiv: https://arxiv.org/abs/2510.02426
  - TeX snapshot (local): `references/arxiv_src/2510.02426/src/Q2C.tex`
- Grammar-Constrained Decoding:
  - arXiv: https://arxiv.org/abs/2305.13971
  - TeX snapshot (local): [acl2023.tex](../../references/arxiv_src/2305.13971/src/acl2023.tex) (+ [00_abstract.tex](../../references/arxiv_src/2305.13971/src/sections/00_abstract.tex), [03_method.tex](../../references/arxiv_src/2305.13971/src/sections/03_method.tex))

## Extraction focus (what we looked for)

1) **可执行机制**：角色分工、任务分解、状态/记忆结构、工具层、评测/门禁、可恢复性。
2) **长期任务处理**：context/进度管理策略，是否有结构化 plan/更新协议或 tree/branch 机制。
3) **可靠性工程**：证据锚点、可复现交付物、失败模式与稳定性度量、人的监督点。

## Outputs (KB/doc deltas)

KB notes updated/added:
- [arxiv-2512.19799-physmaster.md](../literature/arxiv-2512.19799-physmaster.md) (RefKey: `arxiv-2512.19799-physmaster`)
- [recid-2968660-agents-of-discovery.md](../literature/recid-2968660-agents-of-discovery.md)
- [recid-3062816-argoloom.md](../literature/recid-3062816-argoloom.md)
- [arxiv-2305.13971-grammar-constrained-decoding.md](../literature/arxiv-2305.13971-grammar-constrained-decoding.md)

Design integration doc updated:
- [docs/AGENT_LITERATURE_INTEGRATION.md](../../docs/AGENT_LITERATURE_INTEGRATION.md) (新增 PhysMaster/Agents of Discovery/ArgoLOOM 对应的 adopt-now/later)

Reference hygiene updated:
- [Draft_Derivation.md](../../Draft_Derivation.md) References 增补三篇核心对照文献（PhysMaster / Agents of Discovery / ArgoLOOM）
- [PREWORK.md](../../PREWORK.md) coverage matrix 增补 “AI scientist systems (non-HEP)” 维度条目

Search log (append-only):
- [literature_queries.md](literature_queries.md) 追加记录（2509.08535 / 2510.02426）

## Adopt-now / later summary (project-level)

Adopt now (low-cost, high ROI):
- 显式对齐 “LANDAU 三层语义” 到我们的 KB 结构（literature/methodology_traces+evolution/priors），并在设计文档中写清映射与用途。
- 将 prompt/tool list/运行指标（calls/tool calls/errors/latency/tokens/cost）作为 run-card/artifacts 的标准字段；把稳定性/方差纳入 eval（不只 pass/fail）。
- 强化“交付物导向”：每个 workflow 默认产物包括可复跑的 config/run-card/scripts/logs（不仅是文本结论）。

Later (requires infra + eval guardrails):
- 引入 MCTS/tree-based long-horizon 调度骨架：以门禁/评测为 reward；必须绑定回归评测、防 reward hacking、以及回滚/消融。
- 将 Quick Thinker / Reasoner 的双路检索做成 W1 的可选模式，并把覆盖率/噪声控制写进 eval。

## Open questions / follow-ups

- 如果未来要真正做 grammar-constrained decoding：需要支持 logits 的 runner（纯 API 模式通常不可用）；短期优先做 schema 校验 + retry / function calling。
- MCTS/tree 引入前，先完成 T29（结构化 Plan/Plan-Updater）作为 long-horizon 的最小状态骨架。
