# ADR-001：Beads（bd）评估结论——不集成

状态：**已接受（ACCEPTED）**  
日期：**2026-02-05**  
决策负责人：**hep-autoresearch 维护者**

## 背景

我们评估了 **Beads**（命令 `bd`）是否应纳入 `hep-autoresearch` 的生态与工作流。

Beads 自我定位为面向 AI agents 的 **分布式、git-backed、依赖图（DAG）驱动的 issue/task 跟踪器**，其“持久任务记忆”主要由以下机制构成：
- 每项目 SQLite 缓存 + git 跟踪的 JSONL 导出（`.beads/issues.jsonl`）
- 可选的 per-project daemon（`.beads/bd.sock`）以及可选 MCP server（`beads-mcp`）
- “ready work”（`bd ready`）与任务压缩（compaction / memory decay）等工作流能力

而本项目已经实现了面向研究工作流的状态与证据体系：
- Plan SSOT：`specs/plan.schema.json`，绑定到 `.autoresearch/state.json`
- 追加式 ledger：`.autoresearch/ledger.jsonl`
- Evidence-first artifacts：`artifacts/runs/<tag>/...`（manifest/summary/analysis）
- A1–A5 门禁 + Opus/Gemini 双审查收敛后才允许提交

## 决策

我们决定 **不在 `hep-autoresearch` 中集成 Beads**：
- 不引入对 `bd` / `beads-mcp` 的运行时依赖
- 不在仓库层面采用 `.beads/` 作为新的/额外的 SSOT
- **不做任何可选桥接/导出**（无论只读还是双向）

维护者可以在个人层面使用 Beads 做“通用项目管理”，但它 **不属于本仓库的工作流契约**，也不应成为用户使用本项目的必需安装项。

## 理由

1. **SSOT 冲突**：Beads 会引入另一套任务状态 SSOT（SQLite/JSONL），与我们围绕“run provenance + approvals + artifacts”的 Plan/ledger SSOT 发生竞争与去同步风险。
2. **daemon/auto-sync 模型不匹配**：Beads 的后台 daemon 与潜在 auto-commit 工作流，与我们“先双审查再提交”的门禁哲学存在张力。
3. **工作流语义不匹配**：`hep-autoresearch` 是 run/evidence-centric（workflow/approval/artifacts），Beads 是 issue-centric（通用任务/史诗）。双向映射成本高且容易漂移。
4. **安全与复杂度成本**：引入新的 daemon + MCP surface 会增加运维与安全边界复杂度，但对当前 roadmap 的增益不明确。

## 影响

- 继续以现有 Plan/ledger 作为唯一任务状态 SSOT。
- 若确实需要 Beads 类能力（依赖图、ready 检测、compaction），应在 **本项目的 Plan/ledger/approval 模型内**实现，并配套 eval 回归约束。
- 文档中不应建议用户为了使用 `hep-autoresearch` 而安装 Beads。

## 备选方案（已考虑）

- **深度集成**（把 Beads 作为项目任务系统 + MCP）：拒绝（SSOT/语义不匹配）。
- **可选只读桥接/导出**：本 ADR 明确拒绝（避免 SSOT 模糊与后续集成漂移）。

## 参考

- [Beads 仓库 — steveyegge/beads](https://github.com/steveyegge/beads)（评估基于 commit `c96e62e6b59cc82a1ee244a98ff450d9ec294d9`）
