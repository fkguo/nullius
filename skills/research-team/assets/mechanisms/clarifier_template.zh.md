# Pre-task Clarifier（ZH：任务澄清与拆解模板）

Project: <PROJECT_NAME>  
Owner: <YOUR_NAME>  
Date: <YYYY-MM-DD>  

目标：在开工前用最小问答把任务拆成可验证的 DAG（里程碑 + DoD），并显式写出 Anti-scope 与 profile-aware 约束，避免“做着做着换题/换标准”。

---

## How to use（与主流程绑定；避免“写了但没用”）

把本文件产出的关键信息同步到主流程文档中（否则 mechanisms 会变成“表面文章”）：

- 同步到 [PREWORK.md](../PREWORK.md)：填 `## Problem Framing Snapshot`（Problem Interpretation + P/D separation + kill criteria）。
- 同步到 [RESEARCH_PLAN.md](../RESEARCH_PLAN.md)：把里程碑拆成 `## Task Board` 的 checkbox 任务（建议显式标注 `(auto)` / `(manual)` 以配合 autopilot）。
- 同步到 [Draft_Derivation.md](../Draft_Derivation.md)：Capsule 只写复现合约；推导/算法细节写在正文（不要把推导塞进 Capsule）。

硬性建议（用于避免验收流于表面）：
- Kill / Narrow criteria：至少写 1 条“显式阈值/条件”（例如包含 `if` 或比较符号 `<`, `>`, `!=` 等）。
- 复杂数值/算法：先在 `knowledge_base/methodology_traces/` 记录候选方法与选择理由，再开始实现（避免 brute force）。

## 0) Profile（必须选一个）

请选择其一（写入并在后续 gate/config 中保持一致）：

- `theory_only`：以推导/逻辑闭合为主
- `numerics_only`：以仿真/数值结果为主
- `mixed`：理论 + 数值联合（默认更严格）
- `exploratory`：探索/发散（允许 warn-only，但必须有 TTL）
- `literature_review`：证据整理/对立观点综述
- `methodology_dev`：方法/工具链开发（接口与测试为主）
- `custom`：自定义（必须写清 gates 与阈值）

Chosen profile: `<PROFILE>`

## 1) 最小问答清单（回答越短越好）

1. 我们要回答的“问题句”是什么（1 句话）？
2. 可观测输出/可比对量是什么（最多 3 个）？（写清定义/单位/符号约定）
3. 预期证据类型是什么？（推导/计算/实验/文献/混合）
4. 最小可证伪条件是什么？（什么结果会让我们立即缩小 scope 或 fork）
5. 最大不确定性/主要风险是什么？（1–2 条）
6. 依赖外部输入/匹配项有哪些？（列出并标注 MATCHING）

## 2) 任务 DAG（里程碑 + DoD）

写成节点化任务（每个节点都可验收）。建议 3–6 个里程碑即可。

### M0 — Preflight / Skeleton
- Deliverables (paths):
- DoD（Definition of Done）:
- Kill / Narrow criteria:

### M1 — Core Evidence (P/D separation)
- Deliverables (paths):
- DoD:
- Kill / Narrow criteria:

### M2 — Cross-check / External consistency
- Deliverables (paths):
- DoD:
- Kill / Narrow criteria:

## 3) Anti-scope（必须写）

明确“不做什么”，并给出理由（避免 scope creep）：
- Out-of-scope 1:
- Out-of-scope 2:

## 4) 证据链与记录映射（写清写到哪里）

- Claim DAG：`knowledge_graph/claims.jsonl`（哪些结论必须 claim 化？）
- Evidence：`knowledge_graph/evidence_manifest.jsonl`（哪些产物算 evidence？）
- Trajectory：`team/trajectory_index.json`（每轮 tag 的产物/分歧记录）
- Knowledge base：`knowledge_base/{literature,methodology_traces,priors}/`

## 5) Fail-fast 规则（建议默认启用）

当发生以下任一情况，必须停止“继续堆内容”，转为 Correction / Fork / Scope-narrow：

- 关键定义不一致（同名不同物）
- 推导链断裂且无法补齐
- 数值结果对输入/实现不稳定且无法解释
- 找到强反例或文献直接否定
