# Prompt: REDESIGN_PLAN + Tracker 修订 — Scope Audit + Pipeline 连通性收敛结论落地

> 本 prompt 用于新开 Claude Code 对话。
> 工作目录: `/home/user/Coding/Agents/autoresearch-lab/`（monorepo）
>
> **Serena 项目**: `autoresearch-lab`（已配置，onboarding 记忆已就绪）
> **启动前必读 Serena 记忆**: `architecture-decisions`（含三模型 scope audit 收敛结论 + CLI-First Dual-Mode 架构决策 + 质量优先成本哲学 + Pipeline 连通性审计）

---

## 背景

两轮三模型 scope audit + Pipeline 连通性审计已完成，产出以下收敛报告：

| 报告 | 路径 | 内容 |
|------|------|------|
| Scope Audit 收敛 | `meta/docs/scope-audit-converged.md` | 过度/欠工程化评估、优先级重排、SDK 策略 |
| Dual-Mode 架构收敛 | `meta/docs/scope-audit-dual-mode-converged.md` | CLI-First 验证、idea-engine/W_compute/workflow 架构 |
| Pipeline 连通性审计 | `meta/docs/pipeline-connectivity-audit.md` | 5 孤岛 + 12 缺口 + NEW-CONN-01~05 (双模型 R4 收敛) |

### 已完成的实现

| 批次 | Commit | 完成项 |
|------|--------|--------|
| Phase 0 | 多次 | NEW-05, NEW-05a (Stage 1-2), C-01~C-04, H-08, H-14a, H-20, NEW-R02a, NEW-R03a, NEW-R13, NEW-R15-spec, NEW-R16 |
| Phase 1 Batch 1 | `617d798`, `cac9047` | H-16a (tool names), NEW-01 (codegen), H-11a Phase 1 (risk levels) |
| Phase 1 Batch 2 | `929f693` | H-15a (EcosystemID), H-18 (ArtifactRef), H-03 (RunState), H-04 (Gate Registry), H-11a Phase 2 (dispatcher) |

**已实现但需要根据 scope audit 结论修改的项目** (不考虑向后兼容，以质量为最高要义):

| 项目 | 当前状态 | Scope Audit 结论 | 需修改内容 |
|------|---------|-----------------|-----------|
| H-15a EcosystemID | done (929f693) | 3/3 冻结不扩展 | 无需修改代码，但 REDESIGN_PLAN 需标注"已实现，冻结" |
| H-04 Gate Registry | done (929f693) | 2/3 简化 (Codex 保留意见) | 已实现版本含 ~120 LOC (GateType/GateScope/FailBehavior/GateSpec/GATE_REGISTRY/GATE_BY_NAME/getGateSpec)。Scope audit 建议简化到 const array + type + lookup (~30 LOC)。**评估是否需要精简还是保持现有实现** |
| H-01 AutoresearchError | pending | 3/3 简化为 McpError += retryable + retry_after_ms | 不创建独立错误信封 |
| M-22 GateSpec 通用抽象 | pending | 3/3 defer to Phase 3 | Phase 1 标注 defer |

### 当前关键路径 (Phase 1 剩余)

```
Phase 1 Batch 2 done ✅ → 以下现可执行:
  ├─ H-01 AutoresearchError → McpError += retryable + retry_after_ms (~20 LOC)
  │  ├─ H-02 最小可观测性 (depends: H-01)
  │  └─ H-19 失败分类 + 重试策略 (depends: H-01) ← Scope Audit P1 最优先
  └─ M-22 GateSpec → defer to Phase 3
```

---

## 核心设计原则 (来自 scope audit 收敛)

以下原则**必须**贯穿所有修改：

### 1. 质量优先，不设硬性成本限额

科学研究以质量为最高标准。不设 `max_cost_usd` / `max_llm_tokens` 等硬限制。Budget tracking 仅作为 Phase 3 observability，不作为 runtime constraint。质量门禁 (Approval Gates A1-A5) 是 pipeline 控制机制。

### 2. 避免过度工程化

- 已实现的过度抽象 (EcosystemId branded type) **冻结不扩展**，不在其他模块强制使用
- 新增项目以最简实现为目标 (e.g., retry ~50 LOC, McpError += 2 fields)
- 不为假想场景设计（不设 RunBudget 接口、不做框架级抽象）

### 3. 避免欠工程化

- 运行时可靠性是真正的缺口：retry/backoff、MCP reconnect、structured tracing、durable execution
- 这些项必须有独立 ID、明确依赖、可追踪（不是"Phase 2 顺带做"）

### 4. TS 统一策略

- 运行时基础设施只建在 TS 侧
- idea-core → idea-engine TS 重写恢复原计划 (Phase 2-3 增量，非 big-bang)
- hep-autoresearch → TS orchestrator 决策不变
- Python 退役与两者同步

### 5. CLI-First Dual-Mode

- Phase 1-2: CLI agents (Claude Code/Codex/OpenCode) 作为 agent loop
- Phase 3+: 自建 AgentRunner
- MCP 是 Layer 1-3 之间的干净边界
- Workflow schema 是 SSOT（不允许 prompt-only 逻辑）

### 6. Pipeline 连通性 (双模型 R4 收敛)

**审计发现**: 研究全流程存在 5 个孤岛（idea-core, W_compute+hep-calc, 文献发现, 交叉检验, 编排器）和 12 个缺失连接。详见 `meta/docs/pipeline-connectivity-audit.md`。

**关键 schema 决策**: `EvidenceCatalogItemV1` 要求 `paper_id: string` + `locator: LatexLocatorV1`，是 LaTeX 特有的。计算结果**不能**存入此格式。解决方案: 创建并行的 `ComputationEvidenceCatalogItemV1` schema (JSON Schema SSOT in `meta/schemas/`, codegen via NEW-01)，含 `source_type: "computation"`, `ComputationLocatorV1` (artifact_uri + json_pointer + artifact_sha256), 以及 domain-specific 字段 (value, uncertainty, unit)。BM25 index builder 合并两类 evidence。LaTeX-only 消费者 (playback, citation verifier) 按 `paper_id` 过滤，自然跳过计算 evidence。

**next_actions 语义**: 是 hint-only 建议 (221+ 次使用, 33 个文件, 从不自动执行)。遵循现有 `{ tool, args, reason }` 惯例。

**Pipeline A/B 统一时间线**:
1. Phase 2: NEW-IDEA-01 + NEW-COMP-01 → Pipeline A 能力暴露为 MCP
2. Phase 2-2B: NEW-CONN-01~04 → 所有阶段通过 hint-only next_actions 连通
3. Phase 3: NEW-COMP-02 (完整 W_compute MCP), NEW-CONN-05 (交叉检验)
4. Phase 4: Pipeline A (hepar CLI) 退役

---

## 任务

### Task 1: 修改 REDESIGN_PLAN.md

**读取**: `meta/REDESIGN_PLAN.md` (2393 行, 119 项)

**读取收敛报告**: `meta/docs/scope-audit-converged.md` + `meta/docs/scope-audit-dual-mode-converged.md` + `meta/docs/pipeline-connectivity-audit.md`

#### 1A: 修改现有项

| 项目 ID | 修改内容 | 来源 |
|---------|---------|------|
| **H-01** | 简化描述: McpError += `retryable` + `retry_after_ms`，不创建独立 AutoresearchError 信封 | 3/3 |
| **H-04** | 标注 scope audit 结论（2/3 建议简化，Codex 保留意见）；评估现有实现是否需要精简 | 2/3 |
| **H-15a** | 标注"已实现，冻结不扩展" | 3/3 |
| **H-17** | 明确标注 defer to Phase 2 | 3/3 |
| **M-22** | 明确标注 defer to Phase 3 | 3/3 |
| **NEW-R09** | 标注 cut（hep-autoresearch 整体退役，不单独拆分） | 3/3 |
| **NEW-05a** | **拆分 + re-scope**: Stage 1-2 (orchestrator) 标为 done; Stage 3 (idea-engine TS 重写) 标为 not_started，Phase 2-3 增量迁移。修正: 文中 `state-machine.ts` 引用不存在，实际是 `state-manager.ts` | 勘误 |
| **UX-02** | 升级为 computation contract: 可编译为 run-cards / skill jobs，含 acceptance checks + expected outputs。**追加**: 指定输出格式兼容 EvidenceCatalogItemV1 JSONL（使计算结果原生可被 writing pipeline 消费） | 2/3 + CONN 审计 |
| **UX-04** | 扩展为 workflow schema: 含计算节点、`orch_run_*` gate 操作，可执行而非仅文档 | 2/3 |
| **EVO-01/02/03** | 添加依赖: UX-02, UX-04, NEW-R15-impl, NEW-COMP-01 | 2/3 |
| **NEW-WF-01** | **扩展**: schema 定义 entry point variants (from_literature, from_idea, from_computation, from_existing_paper)。初始引用 CONN-01~03，CONN-04 就绪后加入 | CONN 审计 R2-R4 |
| **NEW-COMP-01** | **追加交付物**: 设计包含 `hep_run_ingest_skill_artifacts` 工具规格。该工具的契约由 NEW-COMP-01 作为 single SSOT | CONN 审计 R3 |
| **README** | 替换当前 monorepo 根 README.md（目前是 hep-research-mcp 的旧 README，不适合作为 monorepo 主文档）。新 README 应包含: 生态圈概览、已完成组件、待开发部分 (链接到 REDESIGN_PLAN)、开发命令、子包索引。作为 Task 5 (低优先) 在主修改完成后执行。 | 勘误 |

#### 1B: 新增项

| 项目 ID | Phase | 内容 | 估计 LOC | 依赖 |
|---------|-------|------|---------|------|
| **NEW-CONN-01** | Phase 1 | **Discovery next_actions hints**: 向 `inspire_search`, `inspire_research_navigator`, `inspire_deep_research` (mode=analyze→synthesize→write 链), `hep_import_from_zotero` 返回 JSON 添加 hint-only `next_actions`。确定性规则 (papers.length > 0 + cap 10 recids)。遵循现有 `{ tool, args, reason }` 惯例。不自动执行。 | ~100 | H-16a |
| **NEW-CONN-02** | Phase 2 | **Review feedback next_actions**: `submitReview` 在 `follow_up_evidence_queries.length > 0` 时添加 `next_actions` (建议 `inspire_search` + `hep_run_build_writing_evidence`, max 5 queries, max 200 chars each)；在 `recommended_resume_from` 存在时建议具体 writing 工具。Hint-only。 | ~60 | — |
| **NEW-CONN-03** | Phase 2 | **Computation evidence ingestion**: (1) 定义 `ComputationEvidenceCatalogItemV1` JSON Schema (SSOT in `meta/schemas/`, codegen via NEW-01)。**不修改** EvidenceCatalogItemV1 — 并行 schema。(2) 实现 `hep_run_ingest_skill_artifacts` MCP 工具 (per NEW-COMP-01 spec): 读取 skill SSOT artifacts via ArtifactRef URI, 写入 `computation_evidence_catalog_v1.jsonl`。(3) 扩展 `buildRunEvidenceIndexV1` 合并计算 evidence 到 BM25 index (~30 LOC)。Schema 变更需双模型审核。 | ~250 | NEW-COMP-01, NEW-01 |
| **NEW-CONN-04** | Phase 2B | **Idea → Run creation**: `hep_run_create_from_idea` 接收 IdeaHandoffC2 URI, 创建 project + run, stage thesis/claims 为 outline seed, 返回 hint-only `next_actions` (inspire_search + build_evidence + ingest_skill_artifacts)。纯 staging，无网络调用。 | ~150 | NEW-IDEA-01 |
| **NEW-CONN-05** | Phase 3 (deferred) | **Cross-validation → Pipeline**: `hep_run_build_measurements` 和 `hep_project_compare_measurements` 在发现 tension 时返回 `next_actions` 到 review/revision。扩展 measurements 消费计算 evidence。依赖 NEW-CONN-03 先实现。 | ~100 | NEW-CONN-03 |
| **NEW-IDEA-01** | Phase 2 | idea-core MCP 包装 (`@autoresearch/idea-mcp`): MCP 工具暴露 campaign.*, search.step, eval.run | ~400-800 | H-01, H-02, H-03, H-16a |
| **NEW-COMP-01** | Phase 2 late | W_compute MCP 工具表面设计 + 安全模型 (C-02 containment + A3 gating)。**追加**: 包含 `hep_run_ingest_skill_artifacts` 工具规格作为交付物 (single SSOT) | ~200 (设计) | C-02, NEW-R15-impl |
| **NEW-COMP-02** | Phase 3 | W_compute MCP 实现 (`compute_run_card_v2` / `compute_status` / `compute_resolve_gate`) | ~500 | NEW-COMP-01 |
| **NEW-WF-01** | Phase 2 | `research_workflow_v1.schema.json` 设计 — 声明式研究工作流图 + 统一状态模型 + entry point variants (from_literature/idea/computation/existing_paper) + 模板 | ~100 (schema) | UX-04 |
| **NEW-SKILL-01** | Phase 3 | `lean4-verify` skill (SKILL.md + run_lean4.sh + status.json) | ~200 | — |
| **NEW-RT-01** | Phase 2 early | TS AgentRunner: Anthropic SDK + tool dispatch + lane queue + max_turns + approval gate injection | ~250 | NEW-R15-impl |
| **NEW-RT-02** | Phase 2 early | MCP StdioClient reconnect: 检测断连 + 自动重启 + 恢复 | ~100 | H-19 |
| **NEW-RT-03** | Phase 2 mid | OTel-aligned Span tracing: 手写 Span interface + JSONL writer | ~150 | H-02 |
| **NEW-RT-04** | Phase 2 late | Durable execution: RunManifest last_completed_step + resume_from + checkpoint | ~200 | NEW-RT-01 |
| **NEW-RT-05** | Phase 3 | Eval framework: agent-level 端到端评估 | ~500 | NEW-RT-01, RT-03 |

#### 1C: 依赖变更

```
新增依赖:
  UX-04 → NEW-R15-impl           (recipes 需要 orch_run_* 存在)
  EVO-01 → UX-02, UX-04, NEW-R15-impl, NEW-COMP-01
  EVO-03 → NEW-IDEA-01           (idea→writing evidence 需要 idea MCP)
  NEW-COMP-02 → NEW-COMP-01, C-02 (安全先行)
  NEW-IDEA-01 → H-01, H-02, H-03 (错误信封 + trace + RunState)

Pipeline 连通性依赖 (双模型 R4 收敛):
  NEW-CONN-01 → H-16a             (工具名常量)
  NEW-CONN-02 → (无)              (独立)
  NEW-CONN-03 → NEW-COMP-01, NEW-01 (spec SSOT + codegen)
  NEW-CONN-04 → NEW-IDEA-01       (idea MCP 桥接)
  NEW-CONN-05 → NEW-CONN-03       (Phase 3 deferred)
  NEW-WF-01 references: NEW-CONN-01, 02, 03 (CONN-04 就绪后追加)
```

#### 1D: 版本号更新

REDESIGN_PLAN 版本从 `1.7.0-draft` 更新到 `1.8.0-draft`，changelog 中记录:
- Scope audit 三模型收敛结论落地
- Pipeline 连通性审计 (双模型 R4 收敛): 新增 NEW-CONN-01~05
- 新增 15 项 (NEW-CONN-01~05, NEW-IDEA-01, NEW-COMP-01/02, NEW-WF-01, NEW-SKILL-01, NEW-RT-01~05)
- 修改 13 项 (H-01, H-04, H-15a, H-17, M-22, NEW-R09, NEW-05a, UX-02, UX-04, EVO-01/02/03, NEW-WF-01, NEW-COMP-01)
- CLI-First Dual-Mode 架构确立
- 质量优先成本哲学写入全局约束
- ComputationEvidenceCatalogItemV1 并行 schema 确立 (不修改 EvidenceCatalogItemV1)

### Task 2: 修改 Tracker

**读取**: `meta/remediation_tracker_v1.json`

当前状态: 15 done, 11 design_complete, 93 pending

修改内容:
1. **NEW-05a**: 拆分为 NEW-05a-stage12 (done) 和 NEW-05a-stage3 (pending, Phase 2-3)
2. **H-01**: status 保持 pending，更新 title 和 description 为简化版 (McpError += retryable)
3. **H-04**: 添加 scope_audit_note 字段标注现有实现状态
4. **H-15a**: 添加 scope_audit_note: "冻结不扩展"
5. **H-17**: 添加 deferred_to: "Phase 2"
6. **M-22**: 添加 deferred_to: "Phase 3"
7. **NEW-R09**: status → "cut", cut_reason: "hep-autoresearch 整体退役"
8. **NEW-WF-01**: 更新描述添加 entry point variants
9. **NEW-COMP-01**: 更新描述添加 hep_run_ingest_skill_artifacts 工具规格
10. **UX-02**: 更新描述添加 EvidenceCatalog 兼容输出格式
11. 新增所有 Task 1B 中的项目 (initial status: pending)，包括 NEW-CONN-01~05

### Task 3: 更新 Phase 路线图

在 REDESIGN_PLAN 中更新依赖拓扑总览和 Phase 清单，反映修订后的路线图:

```
Phase 1 (统一抽象) — 当前执行中:
  已完成: H-16a, NEW-01, H-11a P1/P2, H-15a, H-18, H-03, H-04
  剩余: H-01 (simplify), H-02, H-19 (P1 最优先), H-13, NEW-CONN-01 (hint-only, ~100 LOC)
  defer: M-22 → Phase 3, H-17 → Phase 2
  cut: NEW-R09

Phase 2A (运行时可靠性):
  H-19 retry/backoff (最优先)
  NEW-RT-02 MCP reconnect
  H-01 simplify (McpError += retryable)

Phase 2B (Pipeline 连通):
  NEW-CONN-02: review feedback next_actions (~60 LOC)
  NEW-CONN-03: computation evidence ingestion + ComputationEvidenceCatalogItemV1 (~250 LOC)
  NEW-IDEA-01: idea-core MCP 桥接
  NEW-05a Stage 3: idea-engine TS 增量重写开始
  NEW-WF-01: workflow schema 设计 (含 entry point variants)
  UX-02 升级: computation contract (含 evidence format spec)
  NEW-COMP-01: compute MCP 安全设计 (含 ingest tool spec)
  NEW-CONN-04: idea → run creation (~150 LOC)
  NEW-RT-01: AgentRunner
  NEW-RT-03: structured tracing

Phase 3 (独立 agent + 计算连通):
  NEW-05a Stage 3 续: idea-engine TS 重写完成
  NEW-COMP-02: W_compute MCP 实现
  NEW-CONN-05: cross-validation → pipeline feedback (~100 LOC)
  NEW-SKILL-01: lean4-verify skill
  NEW-RT-04: durable execution
  NEW-RT-05: eval framework
  M-22: GateSpec (if needed)

Phase 4+ (Agent-arXiv 社区):
  idea-core Python 退役
  hep-autoresearch Python 退役 (Pipeline A 退役)
  EVO-01/02/03: idea→compute→writing 循环
  A2A 协议
```

### Task 4: 全局约束更新

在 REDESIGN_PLAN 的 §全局约束 中添加:

```markdown
> **质量优先**: 科学研究以质量为最高标准。不设硬性成本限额。Budget tracking 仅作为
> observability（记录消耗），不作为 runtime constraint。质量门禁 (Approval Gates)
> 是 pipeline 推进的控制机制。
```

---

## 执行顺序

```
Phase A — 读取 + 分析
  1. 完整读取 REDESIGN_PLAN.md (2393 行)
  2. 完整读取两份 scope audit 收敛报告
  3. 读取 tracker JSON
  4. 理解当前依赖拓扑

Phase B — 修改 REDESIGN_PLAN.md (Task 1 + 3 + 4)
  5. 更新全局约束
  6. 修改现有项 (Task 1A)
  7. 新增项 (Task 1B)
  8. 更新依赖拓扑 (Task 1C)
  9. 更新 Phase 路线图 (Task 3)
  10. 更新版本号 (Task 1D)

Phase C — 修改 Tracker (Task 2)
  11. 修改现有项状态/描述
  12. 新增项

Phase D — 双模型收敛检查 (见下文)

Phase E — 修正 + 提交
```

---

## 双模型收敛检查

### 触发依据

REDESIGN_PLAN 修订属于 **REDESIGN_PLAN Phase 级条目新增/修改**，按 CLAUDE.md 规定**必须**执行多模型收敛检查。

### 模型要求

| Runner | 模型 | 推理模式 | 调用方式 |
|--------|------|---------|---------|
| Codex CLI | `gpt-5.2` | xhigh | `codex-cli-runner` skill |
| Gemini CLI | `gemini-3.1-pro-preview` | — | `gemini-cli-runner` skill |

**注意**: Codex 模型必须是 `gpt-5.2`（不是 gpt-5.3-codex），推理模式 `xhigh`。

### 评审 packet 结构

REDESIGN_PLAN 修改完成后，生成评审 packet:

```markdown
# Review Packet: REDESIGN_PLAN v1.8.0 — Scope Audit + Pipeline 连通性收敛落地

## 评审范围
REDESIGN_PLAN.md 全量修订 + tracker 更新

## 评审标准
1. 修改是否准确反映 scope audit 收敛结论？
2. 新增项的 Phase 分配和依赖关系是否正确？
3. 是否存在过度工程化（不必要的抽象/项目）？
4. 是否存在欠工程化（遗漏的运行时缺口）？
5. 修改后的路线图是否自洽（无循环依赖、关键路径合理）？
6. 质量优先原则是否贯穿（无硬性成本限制）？
7. CLI-First Dual-Mode 架构是否一致体现？
8. NEW-CONN-01~05 是否正确覆盖 5 个孤岛、12 个缺口？
9. ComputationEvidenceCatalogItemV1 并行 schema 方案是否正确反映（不修改 EvidenceCatalogItemV1）？
10. Pipeline A/B 统一时间线是否与 Phase 路线图一致？

## 上下文文件
- `meta/REDESIGN_PLAN.md` (修改后)
- `meta/remediation_tracker_v1.json` (修改后)
- `meta/docs/scope-audit-converged.md`
- `meta/docs/scope-audit-dual-mode-converged.md`
- `meta/docs/pipeline-connectivity-audit.md` (新)
```

### 执行方式

使用 `review-swarm` skill（双模型）：

```bash
python3 skills/review-swarm/scripts/bin/run_multi_task.py \
  --out-dir meta/reviews/redesign-plan-update-R1 \
  --system meta/reviews/redesign-plan-update-system.md \
  --prompt meta/reviews/redesign-plan-update-packet.md
```

**如果 review-swarm 遇到问题**，可回退到手动调用:
```bash
# Codex (gpt-5.2 xhigh)
codex --model gpt-5.2 --reasoning xhigh exec < prompt.md > codex-output.md

# Gemini
gemini < prompt.md > gemini-output.md
```

### 收敛判定

- **CONVERGED**: 所有模型 0 blocking issues → 通过
- **NOT_CONVERGED**: 任一模型有 blocking issue → 修正后重新提交 (R+1)
- **最大轮次**: 5 轮。超过 5 轮未收敛 → 人类介入

---

## 约束

- **质量为最高要义**: 不向后兼容，不为假想场景设计
- **避免过度工程化**: 每个新增项必须有明确的"不做什么"边界
- **避免欠工程化**: 运行时可靠性缺口必须有独立追踪项
- **不引入外部 agent 框架**: SDK 管 model interaction，自建管 domain state
- **考虑已实现代码的修改成本**: 如果现有实现虽然略过度但工作正常，冻结优先于重写

---

## Context 管理策略

REDESIGN_PLAN 有 2393 行，务必注意 context 消耗:

1. **分段读取**: 按 Phase 分段读取 REDESIGN_PLAN，不一次性读完
2. **精准编辑**: 用 grep 定位 + offset/limit 读取相关段落，用 Edit 工具精准修改
3. **Tracker 用脚本修改**: tracker 是 JSON，用 Python 脚本批量修改比手动编辑高效
4. **评审 packet 精简**: 只包含 diff 摘要和关键接口，不贴完整 2393 行

---

## 完成后

1. `meta/REDESIGN_PLAN.md` 版本升至 1.8.0-draft
2. `meta/remediation_tracker_v1.json` 反映所有变更
3. 双模型收敛检查 CONVERGED
4. 更新 Serena memory: `architecture-decisions`
5. Git commit + push
6. 输出下一批次 prompt（Phase 1 剩余: H-01 简化 + H-19 retry + H-02 tracing + NEW-CONN-01）
