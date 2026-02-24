# ArgoLOOM — Bakshi et al. (2025)

RefKey: recid-3062816-argoloom
INSPIRE recid: 3062816
arXiv: 2510.02426 [hep-ph]
Links:
- INSPIRE: https://inspirehep.net/literature/3062816
- arXiv: https://arxiv.org/abs/2510.02426
- TeX snapshot (local): [Q2C.tex](../../references/arxiv_src/2510.02426/src/Q2C.tex)

## 为什么与本项目相关

ArgoLOOM 试图把“agentic AI”作为跨子领域（cosmo/collider/nuclear）统一的科学发现管线框架来设计，强调系统轮廓、内部模块与可扩展性。这为我们做 “HEP research autopilot” 提供了一个相近目标的对照组。

## 可借鉴的创新点（可执行层面；来自 TeX 精读）

1) **跨工具/跨学科的统一编排层**
   - 把“不同领域工具链”接入一个统一的 orchestration layer。
2) **小规模问题演示 + 可扩展框架**
   - 用小 demo 验证系统形态，再扩展为更大框架（符合我们 M1→M2 的节奏）。
3) **轻量知识库（RAG）与可解释引用**
   - 用小规模“高信噪比”语料（每域约 5 篇 arXiv）做 FAISS 检索，为推理与计算提供可追溯引用，降低幻觉风险。
4) **可复现交付物（run cards / scripts / logs）作为目标产物**
   - 论文强调输出包含 citations、plots、runcards、config files、data logs、以及可复跑脚本（面向“可运行交付物”而不是纯文本结论）。

## 对我们设计的直接映射（adopt now / later）

- Adopt now：
  - 我们的 `Meta-Orchestrator + MCP tool layer` 已经是相同结构；可以对照其模块边界与接口设计，避免漏掉“跨 pipeline 的 glue”。
  - 将 “domain modules + orchestrator” 的边界写得更像 product：每个 module 的输入/输出用 run-card 固化，并由 artifacts manifest 记录（与 M5/M6 的契约对齐）。
- Later：
  - 如果我们要支持“从 collider → astro/cosmo”的跨域扩展，可以参考它如何组织 tool registry 与跨域上下文。
  - 其 KB 采用“少而精”的 curated corpus；我们可以考虑为 hepar 提供一个 `--kb-profile=curated|minimal|user` 的可选模式，并用 eval 去约束“扩库 vs 噪声”的权衡。

## 需要批判性对待/进一步核查

- 需要看其对可靠性机制的覆盖：是否有明确的审批点、可恢复状态、以及独立复核策略。
- 需要核查其 demo 的可复现性与失败模式处理（是否只是概念展示）。

Verification status: deep-read (TeX snapshot; 架构/KB/模型依赖讨论已核查)
What was checked:
- `Q2C.tex`：Framework architecture and tools、Internal knowledge base、Dependence on backbone model、Getting started
