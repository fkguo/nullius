# CLI-First Dual-Mode + Research Workflow Architecture: 三模型收敛报告

> **Date**: 2026-02-25
> **Models**: Claude Opus 4.6 + GPT-5.2 (xhigh) + Gemini 3.1 Pro Preview
> **Input**: CLI-first 战略提案 + 五个架构问题
> **前置文档**: `meta/docs/scope-audit-converged.md` (三模型 scope audit)

---

## 收敛概要

| 问题 | Claude | Codex (GPT-5.2) | Gemini | 收敛结论 |
|------|--------|-----------------|--------|---------|
| Q1: idea-core → idea-engine | Hybrid: Python MCP + 增量 TS | Hybrid: Python MCP façade → 后续增量 TS | ~~取消 TS 重写~~ | **MCP 桥接 (Phase 2) → TS 重写 (Phase 2-3)**。见勘误 §Q1-errata |
| Q2: computation skills 扩展 | Skills 模式正确，MCP 工具化 | Skills 正确，**分阶段** MCP 化 | Skills 正确，**立即** MCP 化 | **Skills 模式 + 分阶段 MCP** (安全门禁先行) |
| Q3: Workflow Graph | (a)+(b) hybrid | **(b)+(c)** hybrid | **(b)+(a)** hybrid | **声明式 schema (b) + MCP next_actions (a)** |
| Q4: Dual-mode 验证 | Layer 0-3 成立 | 成立，但需 workflow artifact | 成立，context window 风险 | **成立，3 个 must-design-now** |
| Q5: REDESIGN_PLAN | 见下 | 见下 | 见下 | 见下 |

---

## Q1: idea-core → idea-engine — 修正: MCP 桥接 (Phase 2) → TS 重写 (Phase 2-3)

### Q1-errata: 三模型共同的前提错误

三个模型的原始结论基于一个错误前提：**"物理学家贡献壁垒——Python 是科学计算的通用语言，TS 重写提高了 HEP 社区贡献 operators 的门槛。"**

**这是事实错误。** idea-core 的 6,800 LOC 全部是工程基础设施代码：

| 模块 | LOC | 性质 |
|------|-----|------|
| `service.py` (campaign/budget/idempotency/tree search) | 3,165 | 纯工程基础设施 |
| `operators.py` (search operator protocol) | 291 | 算法框架 |
| `domain_pack.py` (domain pack loader) | 80+ | 框架 |
| `store.py` (JSON storage) | ~200 | 基础设施 |
| `rpc/server.py` (JSON-RPC server) | 115 | 基础设施 |
| HEPAR orchestration (4 files) | ~1,000 | 基础设施 |

**物理学家写的代码**（FeynCalc `.wl`、Julia `.jl`、SymPy `.py` 计算脚本等）通过 computation provider（当前首个高优先级路径是 `hep-calc`）以 subprocess 方式运行，与 idea-core 的实现语言完全无关。

此外，hep-autoresearch (Python CLI 编排器) 已经 3/3 一致同意用 TS orchestrator 替代。idea-core 与 hep-autoresearch 性质完全相同（都是 Python 工程基础设施），应该遵循同一迁移策略。原结论存在逻辑上的双重标准。

### 修正后的方案

**Phase 2: MCP 桥接 (过渡方案)**
- NEW-IDEA-01: idea-core MCP 包装 (~400 LOC)，立即连通 pipeline
- 这是**桥接**，不是终态

**Phase 2-3: idea-engine TS 重写 (目标状态，恢复原 NEW-05a Stage 3)**
- 增量迁移，不是 big-bang
- MCP 桥接作为回退/对照
- 迁移顺序: (1) store/idempotency → (2) campaign/budget → (3) operator families 逐个迁移 → (4) domain pack → data-driven manifest → (5) HEPAR orchestration
- 使用 replay golden traces (`idea-core/demo/m2_12_replay.py`) 确保行为一致性

**Phase 4+: idea-core Python 退役**
- 与 hep-autoresearch 退役同步

### TS 统一的理由

1. **生态一致性**: 单一构建链 (pnpm, tsc, vitest)，所有基础设施代码统一为 TS
2. **共享类型**: `@autoresearch/shared` 的 EcosystemId, RunState, ArtifactRef 等可直接使用
3. **CLI agent 生态**: Claude Code, Codex CLI, OpenCode 都是 TS
4. **类型安全**: 对 6,800 LOC 的框架代码，TS 的静态类型检查和 IDE 支持价值显著
5. **维护成本**: 不再需要 Python/TS 双语言构建、测试、CI

### 3/3 仍然正确的部分

- **不做 big-bang 重写**: 增量迁移 + MCP 桥接先行的策略仍然正确
- **MCP 桥接的紧迫性**: 连通 pipeline 的需求不应被 TS 重写阻塞
- **Domain packs 数据驱动化**: 在 TS 重写前将 operator families 从 Python callable 改为 data-driven manifest，是正确的解耦步骤

---

## Q2: computation + Skills 扩展 — 收敛: Skills 模式正确 + 分阶段 MCP 化

### 3/3 一致: Skills 模式是正确的扩展边界

hep-calc 已证明 SKILL.md + shell entry + status.json + `artifacts/runs/<tag>/` 可以包装任何计算后端。新计算包按同一模式扩展:

| 新 Skill | 后端 | 入口 | 备注 |
|----------|------|------|------|
| `fire-ibp` | FIRE / LiteRed / Kira | `run_ibp.sh --job job.yml` | IBP reduction |
| `pysecdec` | pySecDec / FIESTA | `run_numeric_int.sh --job job.yml` | 多圈数值积分 |
| `qgraf-form` | QGraf + FORM | `run_diagram_gen.sh --job job.yml` | 费曼图生成 |
| `lean4-verify` | Lean4 + Lake | `run_lean4.sh --project project/` | 形式化验证 |
| `sympy-calc` | SymPy + 领域扩展 | `run_sympy.sh --job job.yml` | Python 符号计算 |

### Lean4 集成 — 3/3 一致

Lean4 作为 computation graph 中的一个无状态验证节点，完美适配 skills 模式:
- `lake build` 作为 subprocess（Codex 指出 Lake 支持 `--json` 查询）
- 输入: agent 生成的 `.lean` 定理文件
- 输出: `status.json` (PASS/FAIL + proved theorems list) + 构建日志 + `.olean` hashes
- **迭代模式**: agent 循环调用 lean4-verify skill 直到 PASS，然后推进 DAG 到下一节点

### Computation MCP 化 — 分歧与裁决

| | Claude | Codex | Gemini |
|---|--------|-------|--------|
| 时机 | Phase 2 | **Phase 3+** (安全先行) | **Phase 1** (立即) |
| 安全 | 未特别强调 | **C-02 containment + A3 gating** 必须先行 | 未特别强调 |

**收敛裁决**: Codex 的安全关切是正确的。computation executor 若直接暴露任意 `subprocess.run(argv)`，等于给 LLM agent 一个任意命令执行接口。

**分阶段方案**:
1. **Phase 2**: CLI-first 阶段，skills 通过 CLI agent 直接调用（现有模式，安全由人类监督）
2. **Phase 2 late**: 设计 `compute_run_card_v2` MCP 工具的安全模型（C-02 containment + A3 default gating + allowlist）
3. **Phase 3**: 实现 MCP 工具表面，含安全防护

---

## Q3: Research Workflow Graph — 收敛: 声明式 Schema + MCP next_actions

### 3/3 一致: 不能留在 prompt/SKILL.md 里

三个模型都同意工作流逻辑必须从 prompt 中提取出来，成为可持久化、可恢复、可程序化执行的 artifact。

### 收敛方案: Approach (b) + (a)

**声明式 workflow schema** (approach b) 作为 SSOT:
```jsonc
// research_workflow_v1.schema.json (概念)
{
  "workflow_id": "original_research_v1",
  "nodes": [
    {"id": "idea", "tool": "idea_search_step", "gates": ["A1"], "depends_on": []},
    {"id": "literature", "tool": "inspire_deep_research", "mode": "analyze", "depends_on": ["idea"]},
    {"id": "derivation", "skill": "hep-calc", "depends_on": ["literature"]},
    {"id": "computation", "run_card": "compute/run_card.yml", "gates": ["A3"], "depends_on": ["derivation"]},
    {"id": "validation", "skill": "lean4-verify", "depends_on": ["derivation"]},
    {"id": "writing", "tool": "inspire_deep_research", "mode": "write", "depends_on": ["computation", "validation"]},
    {"id": "review", "tool": "hep_run_writing_submit_review", "gates": ["A5"], "depends_on": ["writing"]}
  ]
}
```

**MCP 工具返回 next_actions** (approach a) 动态引导 agent:
- CLI agent 读 next_actions 决定下一步（LLM 智能选择）
- 未来 AgentRunner 程序化执行同一 schema

### Gate 集成

- Gates 标注在 workflow nodes 上
- Agent 调用 `orch_run_request_approval` 请求批准
- 批准后 node 状态从 `BLOCKED` → `READY`
- **静态模板 + 动态冻结**: 启动时选择模板，冻结后 hash 写入 ledger（Codex 建议）

### Codex 独有洞察: Run-card 用于计算子图

Codex 建议计算子图用 computation run-card / execution plan（approach c），整体工作流用声明式 schema (approach b)。这是合理的分层:
- 研究生命周期图: workflow schema (节点 = 工具调用 / skill / run-card)
- 计算子图: computation run-card / execution plan (节点 = 计算阶段)

---

## Q4: CLI-First Dual-Mode 验证 — 收敛: 成立 + 2 个 Must-Design-Now

### 3/3 一致: Layer 0-3 架构成立

当加入 computation 和 idea generation 后，分层仍然有效:

```
Layer 3: Agent Loop (SWAPPABLE)
  Mode A: CLI Agent (Claude/Codex/OpenCode/Qwen/Kimi)
  Mode B: Self-built AgentRunner (Phase 3+)

Layer 2: Research Strategy (SHARED) ← 扩展
  高层 MCP: inspire_deep_research, idea_search_step, compute_run_card_v2
  Skills: hep-calc, lean4-verify, fire-ibp, research-writer, research-team
  Workflow Schema: research_workflow_v1 (声明式)

Layer 1: Primitive Tools (SHARED)
  83+ MCP tools (hep-mcp + idea-mcp + compute-mcp)

Layer 0: Infrastructure (SHARED)
  Artifacts, RunManifest, Ledger, Workflow State, resume_from
```

### 风险

| 风险 | 来源 | 缓解 |
|------|------|------|
| Context window thrashing | Gemini | Workflow MCP 工具支持分页/定向查询 |
| State desync | Gemini | Skill 写 status.json + manifest 后再返回 |
| Mode divergence | Codex | Workflow schema 是 SSOT，不允许 prompt-only 逻辑 |
| Compute 安全 | Codex | C-02 containment + A3 gating |
| Plan drift | Codex | idea-engine stub 导致 tracker 混淆，需 re-scope |

### 质量优先的成本哲学

**科学研究以质量为最高标准，不设硬性成本限额。** 如果某个 cost 限额到了，而研究没有结束，停止研究是不可接受的。

- **Budget tracking 是观测性手段，不是运行时约束**: 记录消耗了多少 token / API 调用 / 时间，供人类事后审计
- **质量门禁 (Approval Gates) 是控制机制**: A1-A5 审批节点通过质量检查和人类判断来控制 pipeline 推进
- **不设 `max_cost_usd` / `max_llm_tokens` 等硬限制**: Phase 3 AgentRunner 可选添加 budget 观测指标，但仅为 observability，不作为 runtime constraint
- ~~`RunBudget` 接口~~ — 不需要。质量门禁 + 观测性追踪足够

### 2 个 Must-Design-Now 项

1. **Workflow Schema 格式 (3/3)**: `research_workflow_v1.schema.json` — 声明式工作流图 + hash-in-ledger + 模板系统。定义统一状态模型，桥接 idea-core / computation / hep_run_writing 三个支柱。

2. **Computation Contract (Codex)**: UX-02 应该是一个**契约** (不仅是目录布局)，能编译为 computation run-cards / execution plans 和/或 skill jobs，带有显式的 acceptance checks 和 expected outputs。

---

## Q5: REDESIGN_PLAN 修改建议 — 收敛

### 修改现有项

| 项目 ID | 原内容 | 修改建议 | 共识度 |
|---------|--------|---------|--------|
| **NEW-05a Stage 3** | idea-core → idea-engine TS 重写 (6,800 LOC) | **恢复原计划 + 前置 MCP 桥接**: Phase 2 先做 MCP 桥接 (NEW-IDEA-01)，Phase 2-3 增量 TS 重写。不做 big-bang | 勘误修正 |
| **UX-02** (Phase 2) | `computation_manifest_v1.schema.json` 目录结构 | **升级为契约**: 可编译为 run-cards / skill jobs，含 acceptance checks + expected outputs | 2/3 (Claude + Codex) |
| **UX-04** (Phase 3) | 结构化工具编排 Recipe | **扩展为 workflow schema**: 含计算节点、`orch_run_*` gate 操作，可执行而非仅文档 | 2/3 (Codex + Gemini) |
| **EVO-01/02/03** (Phase 5) | idea→compute→writing 循环 | **添加依赖**: UX-02 + UX-04 + NEW-R15-impl + NEW-COMP-01 | 2/3 |
| **NEW-05a** (整体) | 编排层 + idea 引擎增量迁移 | **拆分**: 编排层 (已有) 和 idea MCP 包装 (新项) 分离。修正: `state-machine.ts` 引用不存在，实际是 `state-manager.ts` | Codex 独有 |

### 新增项

| 项目 ID | Phase | 内容 | 估计 LOC | 依赖 | 共识度 |
|---------|-------|------|---------|------|--------|
| **NEW-IDEA-01** | Phase 2 | idea-core MCP 包装 (`@autoresearch/idea-mcp`): MCP 工具暴露 campaign.*, search.step, eval.run | ~400-800 | H-01, H-02, H-03, H-16a | 3/3 |
| **NEW-COMP-01** | Phase 2 late | Computation MCP 工具表面设计 + 安全模型 (C-02 containment + A3 gating) | ~200 (设计) | C-02, NEW-R15-impl | 3/3 |
| **NEW-COMP-02** | Phase 3 | Computation MCP 实现 (`compute_run_card_v2` / `compute_status` / `compute_resolve_gate`) | ~500 | NEW-COMP-01 | 3/3 |
| **NEW-WF-01** | Phase 2 | `research_workflow_v1.schema.json` 设计 — 声明式研究工作流图 + 模板 (review, original_research, reproduction) | ~100 (schema) | UX-04 | 3/3 |
| **NEW-SKILL-01** | Phase 3 | `lean4-verify` skill (SKILL.md + run_lean4.sh + status.json) | ~200 | — | 3/3 |

### 砍掉/延后

| 项目 | 动作 | 理由 | 共识度 |
|------|------|------|--------|
| NEW-05a Stage 3 (idea-core TS 重写) | **恢复原计划** (前置 MCP 桥接) | Phase 2 MCP 桥接 → Phase 2-3 增量 TS 重写 → Phase 4 Python 退役 | 勘误修正 |
| AgentRunner (NEW-RT-01) | **延后到 Phase 3** | CLI-first 阶段不需要 | 3/3 |
| 完整 OTel SDK | **不引入** | 手写 Span interface 足够 | 3/3 (上一轮已收敛) |

### 依赖变更

```
新增依赖:
  UX-04 → NEW-R15-impl           (recipes 需要 orch_run_* 存在)
  EVO-01 → UX-02, UX-04, NEW-R15-impl, NEW-COMP-01
  EVO-03 → NEW-IDEA-01           (idea→writing evidence 需要 idea MCP)
  NEW-COMP-02 → NEW-COMP-01, C-02 (安全先行)
  NEW-IDEA-01 → H-01, H-02, H-03 (错误信封 + trace + RunState)
```

---

## 修订后的 Phase 路线图

```
Phase 1-2A (当前 → CLI-first 核心):
  ├── H-19 retry/backoff (最优先)
  ├── H-01 simplify (McpError += retryable)
  ├── H-04 simplify (gates const array)
  ├── MCP 工具质量 + Skills 丰富
  └── research-team 多模型收敛

Phase 2B (CLI-first + pipeline 连通):
  ├── NEW-IDEA-01: idea-core MCP 桥接              ← 立即连通 idea 节点
  ├── NEW-05a Stage 3: idea-engine TS 增量重写开始   ← 与 MCP 桥接并行
  ├── NEW-WF-01: workflow schema 设计              ← 连通各节点的声明式图
  ├── UX-02 升级: computation contract              ← 连通 compute 节点
  └── NEW-COMP-01: compute MCP 安全设计

Phase 3 (独立 agent + 计算连通):
  ├── NEW-05a Stage 3 续: idea-engine TS 重写完成
  ├── NEW-COMP-02: Computation MCP 实现
  ├── NEW-SKILL-01: lean4-verify skill
  ├── NEW-RT-01: AgentRunner (读 workflow schema + 驱动 MCP)
  ├── NEW-RT-04: durable execution
  └── NEW-RT-05: eval framework

Phase 4+ (Agent-arXiv 社区):
  ├── idea-core Python 退役 (与 hep-autoresearch 同步)
  ├── EVO-01: idea→compute 自动化
  ├── EVO-02: compute→idea 反馈
  ├── EVO-03: results→writing evidence
  ├── A2A 协议
  └── (可选) idea-engine TS 增量迁移
```

---

## Blocking Issues

1. **Compute 安全 (Codex, 3/3 认同)**: computation executor 执行 `subprocess.run(argv)`（当前 legacy 实现在 `computation.py` 一侧）。MCP 暴露前必须有 C-02 级别的命令/输出验证 + 默认 A3 gating。这是 NEW-COMP-02 的硬性前置。

2. **Tracker 命名漂移 (Codex)**: NEW-05a 在 tracker 中标为 done，但 `idea-engine/src/index.ts` 仍是 3 行 stub。Stage 3 (idea-engine TS 重写) 需标为 not started，与 Stage 1-2 (orchestrator, 已完成) 分开追踪。

3. **统一状态模型 (Gemini)**: idea-core / computation / hep_run_writing 三个支柱目前用不同状态表示。如果不统一，LLM 无法连接端到端 pipeline。NEW-WF-01 (workflow schema) 应解决此问题。

---

## 附录: 原始模型输出

| 模型 | 文件 | 行数 |
|------|------|------|
| Gemini 3.1 Pro | `/tmp/dual-mode-review/gemini-output.md` | 73 |
| GPT-5.2 (xhigh) | `/tmp/dual-mode-review/codex-output.md` | 125 |
