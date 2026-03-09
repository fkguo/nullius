# Ecosystem integration（skills + hep-research-mcp + hep-autoresearch）

目的：把我们已经共同构建的“工具生态圈”（skills + hep-research-mcp）与本仓库的 `hep-autoresearch`（Orchestrator + workflows + evals + approvals）连接成一个 **smoothly connected** 的整体，而不是多个孤岛脚本。

本文件是 **集成建议 + 约定草案**（不会直接改动其他工具；改动建议另见 `docs/ECOSYSTEM_TOOL_IMPROVEMENTS.md`）。

---

## 1) 生态圈全局视角：谁负责什么

### 1.1 `hep-autoresearch`（本仓库）

定位：**中枢编排层（Orchestrator）+ 可靠性工程层（approvals/evals/artifacts）**。

它应该负责：
- workflow 状态机（`pause/resume/status/approve`）与默认同意点（A1/A3/A4/A5）。
- artifacts 三件套（JSON SSOT）与 `report.md` 派生视图（给人类/LLM 快速定位）。
- eval suite：把“能跑一次”升级为“能稳定通过回归”。
- 统一 run-id/tag、目录布局、证据指针、以及跨工具的 provenance 记录。

它不应该负责：
- 重新发明已经在 skills/MCP 中成熟的能力（例如：paper scaffold、BibTeX 拉取、hep-calc 计算编排）。

### 1.2 skills（我们已有的可复用构件）

下面这些更像“可插拔 worker / sub-systems”：

- `research-team` / `research-team-audit`：多角色分工、独立复核、preflight/门禁模板（适合“研究”与“设计评审”）。
- `review-swarm`：双模型 clean-room 评审/审计收敛 gate（Opus + Gemini）。
- `research-writer`：paper scaffold + deterministic hygiene +（可选）writer→auditor 精修闭环。
- `hep-calc`：HEP 推导/数值复现的可审计计算编排（Mathematica/Julia/LoopTools 等）。
- `deep-learning-lab`：ML/数值实验的可复现实验工程（configs、dataset provenance、artifacts runs）。
- `prl-referee-review`：PRL 风格审稿报告（作为 revision 的外部 reviewer 角色更合适）。

### 1.3 `hep-research-mcp`

定位：**高能物理研究的 MCP 工具层**（尤其是 INSPIRE / 文献 / 写作编排工具链）。

建议作为：
- Orchestrator 的“可选 backend”（在可用时提供更强的检索/写作能力）。
- 或作为“外部服务”，由 `hep-autoresearch` 通过 adapter 调用并把结果落盘到 artifacts（保持本仓库 SSOT 契约不变）。

---

## 2) 关键集成原则（让工具“接得上”）

### 2.1 单一真源：JSON SSOT

约定：
- 对任何 workflow（包括调用外部 skills/MCP），最终结果必须落为：
  - `manifest.json`（输入/版本/产物清单）
  - `summary.json`（关键结论/指标，适合快速扫描）
  - `analysis.json`（详细对照/差异归因/指针定位）
- `report.md` 永远是 **派生物**，可删可再生。

这允许：
- skills/MCP 的输出被“包裹进”统一的 artifacts 契约；
- eval suite 能跨工具做回归；
- L1–L3 自我进化可以绑定到稳定指针（而不是漂移的自然语言）。

### 2.2 统一 run-card（跨工具的输入契约）

建议：把每次运行的“关键配置”固定为一个 run-card（JSON/YAML），并让 Orchestrator 负责：
- 生成 run-card（包含 user intent、约束、同意点、seed、backend 选择、工具版本）。
- 把 run-card 写入 `manifest.json`（或以文件路径形式写入）。
- 在 resume 时读回 run-card，避免“上次怎么跑的”丢失。

这与现有多 agent research orchestration 文献里强调的 run cards / job spec 思路在工程上对齐。

### 2.3 引用与键的分离：RefKey ≠ citekey

约定（已写入 T30 澄清）：
- `RefKey` 是**本项目内部稳定键**（KB 笔记命名/路由）。
- LaTeX `\cite{...}` 必须使用 **BibTeX key**（对 INSPIRE 论文用 INSPIRE 标准 citekey/texkey）。
- 导出必须落 `refkey_to_citekey.json` 做审计映射。

这样做能让：
- KB/Orchestrator 稳定（不随 BibTeX key 变化而重命名文件），
- 论文引用标准（按 INSPIRE），
- 并且两者之间可自动桥接。

---

## 3) “smoothly connected”的推荐运行体验（统一入口但可插拔）

目标体验（对用户/团队）：
- 一个入口：`hep-autoresearch` CLI / Web
- 一个状态机：`status/pause/resume/approve`
- 一套 artifacts：JSON SSOT + `report.md`
- 多个 backend：internal / skills / hep-research-mcp（按 workflow 选择）

建议的 adapter 机制（不要求现在实现）：
- 每个外部工具当成一个“backend”，Orchestrator 只负责：
  1) 组装输入（run-card + 证据束 pointers）
  2) 执行（shell / MCP call）
  3) 收集输出并转写为 artifacts 三件套（或导入其已有 manifest）
  4) 触发 eval + 生成 evolution proposal

---

## 4) 从 T28 文献 deep-read 得到的 adopt-now/later：放进生态圈语境

本节的目的是：避免“文献说了一个优点 → 我们就重复造轮子”。每条建议都要回答：
1) 生态圈里已有哪部分覆盖？
2) 本仓库（Orchestrator/evals）需要补什么“胶水”才能接入？

### 4.1 Adopt-now（建议优先纳入计划，但需要你审核）

1) **运行质量指标标准化（calls/tool calls/errors/latency/tokens/cost）并纳入 eval**
   - 文献来源：Agents of Discovery（稳定性与失败分布）。
   - 生态圈已有：
     - `review-swarm`/`research-team` 的 dual review 已经是质量门禁，但指标口径不统一。
   - 本仓库缺口（胶水）：
     - Orchestrator ledger 需要统一字段，并让每个 backend adapter 填充。

2) **prompt/tool list/run config 作为 run-card 一等公民（强制落盘）**
   - 文献来源：Agents of Discovery（prompt 敏感性）。
   - 生态圈已有：
     - `research-team`/`research-writer` 都倾向文件化 prompt；本仓库已经有 artifacts 契约。
   - 本仓库缺口：
     - 把“prompt/tool list 版本”纳入 `manifest.json` 的标准字段，并进入回归对比。

3) **KB 三层语义显式化 + 最小索引导出（KB index）**
   - 文献来源：近期 AI scientist / agent runtime 文献中的分层知识库实践。
   - 生态圈已有：
     - 目录结构天然对应（literature/methodology_traces/priors）。
   - 本仓库缺口：
     - 一个 deterministic “KB index” 导出（JSON）供 Orchestrator/Reviewer packet 使用。

4) **curated KB profile（少而精）作为可选模式，并用 eval 约束收益/噪声**
   - 文献来源：多 agent / research-runtime 文献中一贯强调的“少而精 seed context + 可审计交付物”实践。
   - 生态圈已有：
     - `knowledge_base/literature/` 可以手工 curated，但缺“模式化开关”。
   - 本仓库缺口：
     - `--kb-profile=curated|minimal|user` 选择逻辑 + 回归用例。

### 4.2 Later（需要 infra + eval guardrails，再纳入计划）

- **MCTS/tree long-horizon 调度骨架**
  - 文献来源：long-horizon agent runtime 文献中的显式分支探索实践。
  - 生态圈已有：
    - Orchestrator 状态机 + eval gate + evolution proposal，具备做 reward 的基础信号。
  - 风险：
    - reward hacking / 错误经验固化；必须先把 T29（Plan/Plan-Updater）与回滚/消融做扎实。

- **真正的 grammar-constrained decoding（token-level）**
  - 文献来源：GCD（需要 logits）。
  - 生态圈已有：
    - schema 校验 + fail-fast + retry（现实可用）。
  - 后置原因：
    - 多数 API runner 不暴露 logits；如要做真 GCD，需要本地模型/支持 logits 的 runner，属于更大工程。

---

## 5) 计划纳入建议（待维护者裁定）

上面 Adopt-now 的 1)–4) 适合拆成后续任务（例如 T31–T34）。
一旦维护者确认纳入，应把这些项写入项目本地 `RESEARCH_PLAN.md`（或等价 Task Board）后再实施，而不是只停留在讨论文档中。
