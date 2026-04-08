# Scope Audit: 三模型收敛报告

> **Date**: 2026-02-25
> **Models**: Claude Opus 4.6 (1M) + GPT-5.2 (xhigh) + Gemini 3.1 Pro Preview
> **Method**: 三模型独立调研 → 对比分析 → 收敛综合
> **Input**: `meta/docs/scope-audit-phase1-2.md` (Claude 原始审计) + 独立 web research (Codex, Gemini)
> **Constraint**: 不直接修改历史 redesign baseline 文档，仅产出收敛后的修订建议；当前 truth 以 live source/tests/front-door docs 为准
> **续篇**: `meta/docs/scope-audit-dual-mode-converged.md` — CLI-First Dual-Mode + Research Workflow Architecture 收敛报告

---

## 收敛概要

三模型对审计核心命题**完全一致同意**:

> **"我们在类型系统层面精雕细琢，却在运行时可靠性层面几乎是裸奔。"**

具体共识点:

| 维度 | 共识程度 | 内容 |
|------|---------|------|
| 核心命题 | **3/3** | 类型抽象先行、运行时裸奔，方向正确 |
| 过度工程化判定 | **3/3 方向一致**，程度有分歧 | EcosystemId/GateSpec/AutoresearchError 均过度；Codex 对 GateSpec 判定更宽容 |
| 欠工程化判定 | **3/3** | 6 个 gap 全部确认存在且紧迫 |
| SDK 策略 | **3/3** | "SDK 管 model interaction，自建管 domain state" |
| 框架不引入 | **3/3** | 不引入 Mastra/LangGraph/Pi/OpenClaw；借鉴模式，不引入依赖 |
| Python TS 抉择 | **3/3** | 运行时基础设施只建在 TS 侧，不在退役的 Python 上投入 |

**分歧点** (下文详述):

| 分歧 | Claude | Codex (GPT-5.2) | Gemini 3.1 Pro |
|------|--------|-----------------|----------------|
| GateSpec 严厉度 | simplify to enum | "a bit harsh"—已有非 approval gates | simplify to enum |
| 优先级排序 | Retry > Agent loop > Tracing > Durable > Eval | Retry+Reconnect+Queue > Durable > Tracing > Agent loop > Eval | Retry > Agent loop > Tracing > Durable > Eval |
| 额外缺口 | 无 | +Lane Queue (per-run_id 串行化) + Session ownership | 无 |
| p-retry 引入 | 自建 ~50 LOC | 自建 | 引入 `p-retry` |
| mcporter 评估 | 不评估 | 评估作为 MCP client 替代候选 | 不评估 |
| OTel 引入方式 | 手写 Span interface | JSONL spans "debuggable in jq" | `@opentelemetry/api` 仅 API 包 |

---

## 1. 框架调研收敛

### 1.1 OpenClaw / Pi Framework

**三模型共识:**
- Pi 的 agent loop 是好的参考实现（精简、可读），但不适合直接采用
- Pi 刻意不支持 MCP，与我们的 MCP-first 架构冲突
- OpenClaw 的 gateway 模式（session management + lane queue）有借鉴价值

**Codex 独有洞察** (其他两个模型未深入):
- OpenClaw 的 **Lane Queue** 是 "durable-ish agent runtime without chaos" 的生产级答案: per-lane FIFO + 全局并发限制 + per-session 顺序保证
- OpenClaw 的 **ACP bridge** (`openclaw acp`) 是 "agent front-end protocol ↔ gateway" 的干净接缝
- Pi 在 OpenClaw 中是 **embedded** 运行（`createAgentSession()`），非子进程
- `@mariozechner/pi-agent-core` 最新版本 ~0.52.x，`pi-mono` repo 最新 tag v0.55.0 (2026-02-24)

**收敛建议:**
- **不采用** Pi/OpenClaw 作为依赖
- **借鉴** OpenClaw 的 lane queue 模式: per-`(project_id, run_id)` 串行化工具调用，防止并发竞争
- **借鉴** Pi 的 "keep the loop small; push complexity outward" 哲学

### 1.2 FARS (Fully Automated Research System)

**三模型共识:**
- FARS 的 "workspace as persistent memory" 模式**强验证**了我们的 RunManifest + Artifacts 方法
- 4 个专业化 agent (Ideation → Planning → Experiment → Writing) 通过共享文件系统协作
- GPU 集群作为 tool 暴露给 experiment agent，与我们的 "compute as tool" 方向一致

**收敛建议:**
- 继续强化 `.autoresearch/` + `runs/` 目录作为唯一 source of truth
- TS Orchestrator 应完全无状态（in-memory），仅读写 RunManifest JSON
- 升级现有 artifact 管理：加入 provenance + content hash + 批准门禁（FARS 没做的）

### 1.3 AI Scientist v2

**三模型共识:**
- 渐进式 agentic tree search (BFTS) + experiment manager 是正确的研究自动化架构
- 我们的 `plan.md` / branching 机制已在向此方向收敛
- 缺失的是运行时支持: checkpoint + resume + evaluation criteria + queueing

**收敛建议:**
- Phase 2-3 实现 tree-search / branching 作为一等运行时原语

### 1.4 Google AI Co-Scientist + Anthropic Multi-Agent

**三模型共识:**
- Supervisor-Worker coalition (Generation → Reflection → Ranking → Evolution) 是研究任务的最优模式
- Anthropic 的 Opus lead + Sonnet workers = 90.2% 提升，强验证 `research-team` 模式
- 关键前提: 运行时必须可靠且有观测性

**收敛建议:**
- `research-team` 多 agent 收敛门禁的方向正确，继续
- 在 TS AgentRunner 中支持注入不同 `system_prompt` 以派生 worker agent

### 1.5 SDK 评估

| SDK | 三模型共识 | 行动 |
|-----|-----------|------|
| `@anthropic-ai/sdk` | **3/3 采用** | TS AgentRunner 的 model interaction 层。`messages.create()` + tool call handling |
| `p-retry` | 2/3 (Gemini 推荐, Codex 中立, Claude 自建) | **收敛: 自建**。~50 LOC 的 retry 不值得引入依赖。hep-mcp 已有完善的 `rateLimiter.ts` 可参考 |
| `@opentelemetry/api` | 2/3 (Gemini 推荐 API-only, Claude/Codex 手写 interface) | **收敛: 手写 Span interface**。仅参考 OTel 语义约定，不安装 SDK。~20 LOC |
| `mcporter` | 1/3 (仅 Codex 建议评估) | **收敛: 不评估**。已有自建 MCP client，mcporter 的 reconnect 价值需要验证但优先级低 |
| PydanticAI | **3/3 仅评估** | Phase 3 时间框定 spike。Python 退役目标下不深度采用 |
| Mastra | **3/3 不采用** | 太年轻 (YC W25)，API 不稳定 |
| ACP SDK (`@agentclientprotocol/sdk`) | 1/3 (仅 Codex 关注) | **收敛: Phase 4+**。需要 "agent as service" 场景才有意义 |

---

## 2. 过度工程化评估收敛

### EcosystemId (H-15a) — 收敛: freeze, don't extend

| | Claude | Codex | Gemini |
|---|--------|-------|--------|
| 判定 | 中-高过度 | mildly overbuilt | 零运行时价值 |
| 行动 | 冻结不扩展 | 冻结不扩展，不强制 branded type | 冻结不扩展 |

**收敛:** 已实现、已测试、沉没成本。冻结。不添加新前缀。不在其他模块强制 `EcosystemId` branded type。

### GateSpec (H-04) — 收敛: simplify (Codex 保留意见)

| | Claude | Codex | Gemini |
|---|--------|-------|--------|
| 判定 | simplify to enum | "a bit harsh"—已有 quality/budget gates | simplify to enum |
| 理由 | 5 gates 不需要类型系统 | 实际已有非 approval gates | 过早泛化 |

**收敛 (2/3 多数):** 简化为 enum + validate。Codex 指出 `gate-registry.ts` 已包含 `quality_*` 和 `budget_token` gates，不仅是 5 个 approval gates。但即使如此，当前实现量（~120 LOC，含 `GateType` 枚举、`GateScope` 枚举、`FailBehavior` 枚举、`GateSpec` 接口、`GATE_REGISTRY` 数组、`GATE_BY_NAME` Map、`getGateSpec` 查找函数）对 10 个 gate 仍然过度。**简化到 const array + type + lookup function (~30 LOC)**，保留 gate name/type 信息但不做 policy/fail_behavior 元系统。

### AutoresearchError (H-01) — 收敛: simplify to McpError extension

**3/3 完全一致:** 不创建独立错误信封。在现有 `McpError` (`packages/shared/src/errors.ts:17`) 中添加 `retryable` + `retry_after_ms`。

Gemini 提供了具体实现参考:
```typescript
export class McpError extends Error {
  public retryable: boolean;
  public retryAfterMs?: number;
  constructor(public code: ErrorCode, message: string, public data?: any) {
    super(message);
    this.retryable = ['RATE_LIMIT', 'UPSTREAM_ERROR'].includes(code);
    this.retryAfterMs = data?.retryAfter;
  }
}
```

### Runtime Handshake (H-17) — 收敛: defer

**3/3 一致:** CI 检查已覆盖。运行时握手在多版本并存时才有价值。

---

## 3. 欠工程化评估收敛

### Gap 优先级排序 — 收敛

| 排名 | Gap | 收敛优先级 | 来源 |
|------|-----|-----------|------|
| **1** | Retry + Backoff + Reconnect | **P1 最优先** | 3/3 一致 |
| **1b** | Lane Queue (per-run_id 串行化) | **P2 early** | Codex 独有洞察，收入 |
| **2** | Agent Loop (TS AgentRunner) | **P2 early** | Claude/Gemini: P2 early; Codex: after durable |
| **3** | Structured Tracing | **P2 mid** | Claude/Gemini: P2 mid; Codex: P2 mid (after durable) |
| **4** | Durable Execution | **P2 late** | 3/3 一致 |
| **5** | MCP Reconnect | **P2 early** | 与 retry 同类 |
| **6** | Eval Framework | **P3** | 3/3 一致 |

**Codex 新增 Gap (收入收敛报告):**

1. **Lane Queue / Single-writer enforcement**: OpenClaw 的 lane queue 解决了 "retry/reconnect 增加非确定性" 的问题。每个 `(project_id, run_id)` 应有独立 FIFO 队列，即使单用户模式也需要防止意外并行工具调用。

2. **Stateful Session Ownership**: 需要一个明确的 SoT 进程拥有 MCP 子进程、run state 和 tool budgets（OpenClaw gateway 的等价物）。

**对 Codex 新增 Gap 的裁决:**
- Lane Queue: **采纳**，作为 AgentRunner (NEW-RT-01) 的内置约束而非独立工作项。AgentRunner 内部保证 per-run 工具调用串行化。
- Session Ownership: **部分采纳**。TS Orchestrator 即是 SoT 进程。不额外构建 gateway 服务（过度）。

---

## 4. 修订建议收敛

### 4.1 Phase 1 项目清单 (收敛版)

**Phase 1A (运行时可靠性 — 最高优先)**:

| 项目 | 动作 | 三模型共识度 |
|------|------|-------------|
| H-19 (retry/backoff) | **提前 + 解耦 H-01** | 3/3 |
| H-13 (context truncation) | keep | 3/3 |

**Phase 1B (核心抽象 — 简化版)**:

| 项目 | 动作 | 三模型共识度 |
|------|------|-------------|
| H-01 (error) | simplify: `McpError` += `retryable` + `retry_after_ms` | 3/3 |
| H-02 (trace_id) | simplify: dispatcher-only UUID injection | 3/3 |
| H-04 (gates) | simplify: const array + type + lookup (~30 LOC) | 2/3 (Codex 保留意见) |
| M-22 (GateSpec) | defer → Phase 3 | 3/3 |
| H-17 (handshake) | defer → Phase 2 | 3/3 |
| NEW-R09 | cut | 3/3 |

### 4.2 新增运行时基础设施项 (收敛版)

| 项目 ID | Phase | 内容 | 估计 LOC | 依赖 | 三模型共识度 |
|---------|-------|------|---------|------|-------------|
| **NEW-RT-01** | P2 early | TS AgentRunner: Anthropic SDK `messages.create` + tool dispatch + lane queue (per-run 串行化) + max_turns + approval gate injection | ~250 | NEW-R15-impl | 3/3 (Codex: 含 lane queue) |
| **NEW-RT-02** | P2 early | MCP StdioClient reconnect: 检测断连 + 自动重启 + 恢复 | ~100 | H-19 | 3/3 |
| **NEW-RT-03** | P2 mid | OTel-aligned Span tracing: 手写 Span interface + JSONL writer + dispatcher 集成 | ~150 | H-02 | 3/3 |
| **NEW-RT-04** | P2 late | Durable execution: RunManifest `last_completed_step` + `resume_from` + checkpoint at step boundaries | ~200 | NEW-RT-01 | 3/3 |
| **NEW-RT-05** | P3 | Eval framework: agent-level 端到端评估 (扩展现有 `tests/eval/`) | ~500 | NEW-RT-01, RT-03 | 3/3 |

### 4.3 SDK 引入建议 (收敛版)

| SDK | 用途 | Phase | 决策 |
|-----|------|-------|------|
| `@anthropic-ai/sdk` | AgentRunner model interaction | P2 | **采用** (3/3) |
| OTel Semantic Conventions | Span 数据模型参考 | P2 | **参考 spec，手写 interface** (2/3) |
| PydanticAI | Python 侧评估 | P3 | **时间框定 spike** (3/3) |

**明确不引入** (3/3 一致):
- Mastra, LangGraph, Google ADK, OpenAI Agents SDK, Pi/OpenClaw (as dependency)
- `p-retry` (自建 ~50 LOC 足够，hep-mcp rateLimiter.ts 可参考)
- 完整 OTel SDK/Collector

### 4.4 对 Batch 2 Prompt 的修订 (收敛版)

1. **H-15a, H-18, H-03**: 已实现，Batch 2 集成测试并提交
2. **H-04**: 简化到 const array + type + lookup (~30 LOC)
3. **H-01**: 简化到 McpError += `retryable` + `retry_after_ms`
4. **新增 H-19**: Batch 2 最优先项，retry/backoff ~50 LOC
5. **不做**: M-22 (defer), H-17 (defer), NEW-R09 (cut)

### 4.5 架构模式借鉴清单 (收敛版)

| 模式 | 来源 | 应用到 | Phase |
|------|------|--------|-------|
| Workspace as persistent memory | FARS | RunManifest + Artifacts 已是，继续强化 | 当前 |
| Lane-aware FIFO queue | OpenClaw | NEW-RT-01 AgentRunner 内置 per-run 串行化 | P2 |
| Supervisor-Worker coalition | Co-Scientist, Anthropic | research-team 收敛门禁 + AgentRunner worker 派生 | P2-3 |
| Tree-search with checkpoints | AI Scientist v2 | NEW-RT-04 checkpoint/resume + branching | P2-3 |
| "Push complexity outside the loop" | Pi | AgentRunner 保持 ~200 LOC，复杂性在 StateManager/ApprovalGate/LedgerWriter | P2 |
| Role decomposition + tournament | Co-Scientist | research-team generate → critique → rank → evolve | P3 |

---

## 5. Blocking Issues

### Python vs TS Chasm (3/3 一致)

**不要在退役目标 (Python hep-autoresearch) 上构建新的运行时基础设施。**

Retry、AgentRunner、Durable Execution、Tracing **只建在 TS orchestrator 中**。Python CLI 通过现有 CLI runner (claude/gemini/codex) 的 tool use 循环继续工作，但不投入新的 agent loop 开发。

Gemini 措辞最激烈: *"Splitting focus will leave both runtimes half-baked."*

### FARS 信息限制 (Codex 标记)

FARS 官网 (analemma.ai) 是 JS-heavy SPA，三个模型均无法可靠获取完整技术文档。架构信息基于二手报道 (36kr, The Paper) + GitHub repos 推断。核心结论（4 agent + shared FS + compute as tool）跨多个独立来源一致，可信度足够。

---

## 附录 A: 原始报告来源

| 模型 | 文件 | 行数 | 方法 |
|------|------|------|------|
| Claude Opus 4.6 | `meta/docs/scope-audit-phase1-2.md` | 353 | 直接代码阅读 + web research |
| GPT-5.2 (xhigh) | `/tmp/scope-audit-review/codex-output.md` | 2009 (含 exec trace) | Codex exec: 代码阅读 + web search (npm, GitHub, arXiv) |
| Gemini 3.1 Pro Preview | `/tmp/scope-audit-review/gemini-output.md` | 118 | Gemini CLI: web search + 结构化评估 |

## 附录 B: REDESIGN_PLAN 净项数变化 (收敛版)

| 度量 | 变更前 | 变更后 | 变化 |
|------|--------|--------|------|
| Phase 1 项数 | 25 | 22 | -3 (cut 2, defer 1) |
| Phase 2 项数 | 27 | 28 | +1 (新增 4 RT, defer 入 3, defer 出 1 VIZ) |
| Phase 3 项数 | 12 | 17 | +5 (接收 defer: M-22, M-20, NEW-VIZ-01, 新增 RT-05, PydanticAI eval) |
| 总净项数 | 119 | 122 | +3 (净增 5 NEW-RT, cut 2) |

**关键变化不是数量而是优先级**: 运行时可靠性项从隐含的 "Phase 2 顺带做" 变成有独立 ID、明确依赖关系、可追踪的工作项。三个模型对此判断完全一致。
