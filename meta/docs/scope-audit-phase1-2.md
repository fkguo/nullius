# Scope Audit: 过度工程化 vs 欠工程化 重新评估

> **Date**: 2026-02-25
> **Context**: Phase 1 Batch 1 完成 (NEW-01, H-16a, H-11a); Batch 2 准备执行 (H-15a, H-18, H-03, H-04)
> **Trigger**: Agent Framework Landscape 调研后的反思 — 发现系统同时存在过度工程化和欠工程化
> **Constraint**: 不直接修改历史 redesign baseline 文档，仅产出修订建议；当前 truth 以 live source/tests/front-door docs 为准

---

## 核心命题

> **我们在类型系统层面精雕细琢，却在运行时可靠性层面几乎是裸奔。**

119 项 REDESIGN_PLAN 中，Phase 1-2 的 ~50 项主要聚焦于类型定义、schema 统一、命名规范、CI 门禁——这些是"设计时正确性"。而实际跑起来时最先崩溃的是：MCP 调用无重试、长 run 崩溃无法恢复、出问题时无 trace 可查、agent 行为退化无法检测。

无向后兼容负担的系统，却在做 branded types 和 prefix registries。

---

## Task 1: Phase 1-2 项目逐项审计

### Phase 1 — 已实现项

| 项目 | LOC | 判定 | 理由 |
|------|-----|------|------|
| **H-16a** (tool names) | ~200 | **keep** | 83 个常量消除了跨组件字符串拼写错误风险。已替换 324 处引用。成本低收益高。 |
| **NEW-01** (codegen) | ~600 | **keep** | JSON Schema → TS/Python 代码生成管线。18 个 schema 产出 36 个类型文件。这是后续所有 schema consumer 的前置条件，收益明确。 |
| **H-11a** (tool risk) | ~180 | **keep** | `ToolRiskLevel` + 静态 map + ToolSpec 注入。编排器策略决策的必要输入。唯一疑点是 `.map()` injection pattern 增加了一层间接性，但可接受。 |

### Phase 1 — 已实现但值得反思

| 项目 | LOC | 判定 | 理由 |
|------|-----|------|------|
| **H-15a** (EcosystemID) | 152 | **simplify (已实现，建议冻结不扩展)** | Branded type `string & { __brand: 'EcosystemId' }` 在无外部用户的系统中过度。前缀注册表是恒等映射 (`proj → 'proj'`)。自定义 `EcosystemIdError` 类、`parseEcosystemId` / `makeEcosystemId` / `isValidEcosystemId` / `isValidOpaque` 四个函数——对 `prefix_opaque` 格式来说工具太多了。**但**: 已实现、已测试、已集成，拆除成本 > 保留成本。建议：冻结，不再扩展（不加新前缀除非真的用到），不在其他地方强制 branded type。 |
| **H-18** (ArtifactRef) | 91 | **keep** | 轻量构造函数 + URI 解析。基于生成类型而非手写 schema。复杂度适中。 |
| **H-03** (RunState) | 103 | **keep** | 7 个 canonical state + legacy 映射表。映射表是过渡期的实际需要。Step-level state 拆分合理。 |

### Phase 1 — 待实现项

| 项目 | 判定 | 理由 |
|------|------|------|
| **H-04** (Gate Registry) | **simplify** | 当前只有 5 个 gate (A1-A5)，全部是 approval 类型。`GATE_REGISTRY` dict + `validate_gates()` 函数就够了（~20 行）。不需要 `GateSpec` 类型、`gate_type` 枚举、`fail_behavior` 字段。这些是 Phase 3+ 才需要的泛化——在连基本 approval flow 都没稳定运行的阶段，过早抽象。 |
| **M-22** (GateSpec) | **defer → Phase 3** | 完全依赖 H-04。H-04 如果简化为 enum + validate，M-22 的存在理由消失。当 Phase 3 引入非 approval 类型的 gate 时再泛化。 |
| **H-01** (AutoresearchError) | **simplify** | 核心价值是 `retryable` + `retry_after_ms`。但方案设计了完整的错误信封 (`domain`, `code`, `message`, `retryable`, `retry_after_ms`, `run_id`, `trace_id`, `data`)，需要 JSON Schema + codegen + TS 工厂 + Python adapter。**简化方案**: 直接在现有 `McpError` 工厂函数中添加 `retryable` 和 `retry_after_ms` 字段（改 2 个函数，~15 行）。独立的错误信封在有 OpenTelemetry trace 后才有充分理由（Phase 2）。 |
| **H-02** (trace_id) | **simplify** | UUID v4 生成 + 注入到 tool call context。核心功能 ~30 行。但方案设计了 ledger 扩展 + MCP client 注入 + 响应提取——这些在 Phase 2 全链路 tracing 中实现更自然。**Phase 1 交付**: 仅在 dispatcher 中生成 trace_id 并写入 tool result，不做跨组件传播。 |
| **H-17** (runtime handshake) | **defer → Phase 2** | Tool catalog hash 比对是 CI 检查的运行时重复。`make codegen-check` + H-16b 契约测试已覆盖此需求。运行时握手在多版本并存时才有价值（当前不存在）。 |
| **H-13** (context truncation) | **keep** | 100KB 截断 + 溢出到 artifact。解决实际 token 爆炸问题。直接实用。 |
| **H-19** (retry + backoff) | **keep + 提前 + 解耦** | 当前 MCP client 完全没有重试。这是最紧迫的运行时缺口。**修订**: 解耦对 H-01 的依赖——不需要等 AutoresearchError 信封，直接在 `McpStdioClient.call_tool_json()` 中基于 MCP error text 判断是否重试。3 次重试 + 指数退避 + jitter，~50 行。 |
| **M-01** (artifact naming) | **simplify** | 正则 lint 脚本检查所有 artifact 文件名。当前 artifact 命名已基本一致（organically evolved）。**简化**: 写进 ECOSYSTEM_DEV_CONTRACT 作为约定，不做 CI lint。lint 在 H-15b (Phase 2) 中随版本化统一一起实现。 |
| **M-18** (config unification) | **keep** | 配置键注册表 + `hepar doctor` 输出。直接解决"为什么 MCP server 只暴露 68 个工具"这类常见困惑。 |
| **M-19** (CI integration tests) | **keep** | 冒烟测试基础设施。简单、高价值。 |
| **M-14a** (log redaction) | **keep** | API key / path 脱敏。安全基线，低成本。 |
| **NEW-R02** (as any CI gate) | **keep** | Diff-scoped grep 阻止新增 `as any`。简单有效。 |
| **NEW-R03b** (Python exception migration) | **defer → Phase 2** | 281 个 handler 的系统性迁移依赖 H-01 完成。如果 H-01 简化，迁移目标改为"添加 logging + 具体 except"而非迁移到新错误信封。这项工作量不变但紧迫性降低。 |
| **NEW-R04** (Zotero dedup) | **keep** | ~2300 LOC 去重。纯重构收益，无抽象风险。 |
| **NEW-R09** (orchestrator_cli split) | **cut** | 决策门禁已触发：NEW-05a 确认从零构建 TS 编排器，Python CLI 是退役目标。拆分退役代码无价值。 |
| **UX-01** (notebook/contract split) | **keep** | 真实用户体验问题。低抽象，高可用性改善。 |
| **UX-05** (lazy scaffold) | **keep** | 减少 init 产出从 20+ 文件到 ≤8 文件。直接可用性改善。 |
| **UX-06** (session protocol) | **keep** | Agent 行为规范文档，不是代码实现。低成本。 |

### Phase 2 — 待实现项

| 项目 | 判定 | 理由 |
|------|------|------|
| **H-05** (file locks) | **keep** | `filelock` 替代 `fcntl.flock`，跨平台。实际需要。 |
| **H-07** (atomic write) | **keep** | `write → fsync → rename`。防止 artifact 损坏。直接价值。 |
| **H-09** (idempotency CAS) | **keep** | 并发提交保护。idea-core 实际会遇到。 |
| **H-10** (ledger event enum) | **keep** | 简单枚举 + 验证。~30 行代码。 |
| **H-11b** (permission composition) | **defer → Phase 3** | 多工具链权限组合策略。当前编排器还不能 chain tool calls，这个需求是假想的。 |
| **H-12** (untrusted content sandbox) | **keep** | Zip Slip + 解压炸弹防护。安全基线。 |
| **H-15b** (artifact versioning) | **keep** | 文件名 `_v{N}` + JSON 内 `schema_version` 双标记。实际需要。 |
| **H-16b** (contract tests CI) | **keep** | 跨组件工具名集合验证。简单高价值。 |
| **H-21** (data path unification) | **keep** | `HEP_DATA_DIR` 统一。常见困惑源。 |
| **M-02** (legacy tool names) | **keep** | 清理 + 别名。低成本。 |
| **M-05** (token counting) | **keep** | 添加 `tokenizer_model` 参数。小改动。 |
| **M-06** (SQLite WAL) | **keep** | `PRAGMA journal_mode=WAL`。1 行代码，消除并发锁。 |
| **M-20** (migration registry) | **defer → Phase 3** | 在无外部用户的系统中，数据格式迁移注册表是过度的。直接 breaking change，旧数据丢弃重建（CLAUDE.md 全局约束明确写了这一点）。 |
| **M-21** (backpressure) | **simplify** | 与 H-13 合并。截断即是背压。不需要独立工作项。 |
| **M-23** (release artifacts) | **defer → Phase 4** | 发布流程在有外部用户时才需要。 |
| **NEW-02** (approval 三件套) | **keep** | `packet_short.md` / `packet.md` / `approval_packet_v1.json`。直接改善人类审批体验。 |
| **NEW-03** (approval CLI) | **keep** | `hepar approvals show`。NEW-02 的自然延伸。 |
| **NEW-04** (human report) | **keep** | 自包含报告生成。直接产出。 |
| **NEW-R05** (evidence abstraction) | **keep** | 8 个文件类型统一。实际一致性问题。 |
| **NEW-R05a** (Pydantic v2) | **keep** | 评估性质，时间框定。 |
| **NEW-R06** (analysis types) | **keep** | 7 个版本化文件整合为 1。 |
| **NEW-R07** (test coverage gate) | **keep** | CI 门禁。低成本。 |
| **NEW-R08** (skills LOC budget) | **keep** | 代码健康。 |
| **NEW-R10** (service.py split) | **cut** | 与 NEW-R09 同理。idea-core → idea-engine TS 迁移使其无价值。 |
| **NEW-R14** (hep-mcp split) | **keep** | 98.6K → 45.7K LOC。实际可维护性改善。 |
| **NEW-R15-impl** (orchestrator tools) | **keep** | `orch_run_*` 工具实现。编排器核心。 |
| **UX-02** (computation dir) | **keep** | 计算代码目录标准化。 |
| **UX-07** (approval context) | **keep** | 审批上下文自动聚合。直接改善决策质量。 |
| **RT-02** (tool access + provenance) | **keep** | research-team 工具访问增强。 |
| **RT-03** (runner abstraction) | **keep** | 统一 runner + API 可配置。 |
| **NEW-VIZ-01** (graph viz) | **defer → Phase 3** | 5 domain adapters + 通用 schema。当前没有可视化消费者。与 Phase 3 EVO-20 Memory Graph 同期实现更合理。 |
| **全链路 trace_id + JSONL** | **keep** | 基于 H-02 的跨组件 tracing。Phase 2 核心交付。 |

### 汇总

| 判定 | 项数 | 示例 |
|------|------|------|
| **keep** | ~35 | H-16a, NEW-01, H-11a, H-03, H-18, H-13, H-19, UX-01/05/06 |
| **simplify** | 5 | H-04, H-01, H-02, M-01, M-21 |
| **defer** | 6 | M-22→P3, H-17→P2, NEW-R03b→P2, M-20→P3, M-23→P4, NEW-VIZ-01→P3 |
| **cut** | 2 | NEW-R09, NEW-R10 |

---

## Task 2: 运行时缺口评估

### Gap 1: MCP 调用无 retry/backoff

**影响**:
- INSPIRE API 偶发 429 (rate limit) → 整个 writing pipeline 失败，需人工重跑
- MCP server 进程偶发超时 → `call_tool_json()` 返回 error，orchestrator 无法恢复
- 实际发生频率: 几乎每个 long writing run 都会遇到至少 1 次

**自建 vs SDK**:
- 自建: ~50 行 Python (retry decorator + exponential backoff + jitter)。已有 `McpToolCallResult.error_code` 可判断是否重试。
- SDK: PydanticAI 的 retry 逻辑更完善但引入重量级依赖。
- **结论**: 自建。50 行代码不值得引入框架依赖。

**优先级**: **高于所有 Phase 1 类型抽象**。这是当前系统最频繁的运行时失败源。

**建议**: 将 H-19 从 Phase 1 late 提前到 Phase 1 **最优先**，解耦对 H-01 的依赖。

### Gap 2: Agent loop 抽象缺失

**影响**:
- 完全依赖 Claude Code / Gemini CLI 的 tool use 循环
- TS 编排器 (`packages/orchestrator/`) 只有 scaffold（state-manager, ledger-writer, mcp-client, approval-gate），没有 agent loop
- 无法程序化地执行 "调用工具 A → 根据结果决定调用 B 或 C → 处理错误 → 继续" 的逻辑

**自建 vs SDK**:
- Anthropic SDK: `messages.create()` + tool call handling 是标准模式。~200 LOC 即可实现完整 agent loop（send message → collect tool_use blocks → execute tools → send tool_result → loop）。
- PydanticAI: `Agent.run()` 封装了这个循环，但 Python-only 且引入 Pydantic 全栈依赖。
- Mastra: TS-native agent loop，但太年轻 (YC W25)，API 不稳定。
- **结论**: TS 侧基于 Anthropic SDK 自建 thin AgentRunner (~200 LOC)。Python 侧不需要（Python orchestrator 是退役目标）。

**优先级**: Phase 2 早期。当前 TS 编排器有 scaffold 但无执行能力。

**建议**: 在 Phase 2 NEW-R15-impl (编排器工具实现) 之后，添加 thin AgentRunner 作为新工作项。

### Gap 3: 结构化 tracing 缺失

**影响**:
- 多步骤操作失败时，只能看到最后一个错误。无法知道: 哪步失败、前面几步成功了什么、耗时分布如何。
- Ledger 是 flat JSONL，没有 span 嵌套（"写作管线" → "build evidence" → "inspire_search"）。
- 实际排查时需要手动 grep 多个日志文件。

**自建 vs SDK**:
- OpenTelemetry JS/Python SDK 提供 span API。可以增量接入：先在 dispatcher 中创建 root span，逐步扩展。
- 不需要 Jaeger/Zipkin 等后端。写入 JSONL（结构化 span 格式）+ `jq` 查询已经比当前好 10x。
- **结论**: Phase 2 H-02 全链路 tracing 对齐 OpenTelemetry span 格式。不需要完整 OTel collector，只需 span 数据模型。

**优先级**: Phase 2 中等。比类型抽象重要，但比 retry 不紧迫（tracing 改善诊断速度，retry 减少故障本身）。

### Gap 4: Eval framework 缺失

**影响**:
- 工具实现变更后无法系统性验证 agent 行为不退化
- 当前只有单元测试（函数级），无 agent-level 端到端评估
- 例如: 修改 `inspire_search` 内部逻辑后，无法验证"搜索 pentaquark 回顾论文"是否仍能产出合理结果

**自建 vs SDK**:
- PydanticAI 有 eval 框架，但 Python-only
- Google ADK 有 eval，但 Python-only
- TS 侧无现成 eval 框架
- **结论**: Phase 3+ 自建。评估框架需要先稳定工具行为（Phase 2），然后才有基线可对比。

**优先级**: Phase 3。当前优先级低于 retry 和 tracing。

### Gap 5: Durable execution (checkpoint/resume)

**影响**:
- 长 writing run (~30 分钟) 崩溃后需完全重来
- RunManifest 跟踪 run state 但不支持断点续跑
- 中间 artifact 会保留（因为是文件），但 pipeline 逻辑状态丢失

**自建 vs SDK**:
- PydanticAI 和 LangGraph 有 durable execution，但引入完整框架代价高
- 自建: 扩展 RunManifest 添加 `last_completed_step` + `resume_from`。writing pipeline 已有 `resume_from` 参数（`inspire_deep_research` 的 `resume_from` 枚举），但实现不完整。
- **结论**: Phase 2-3 增量自建。基于现有 RunManifest + `resume_from` 模式完善。

**优先级**: Phase 2 late / Phase 3 early。频率低于 retry 故障，但影响大（30 分钟重来 vs 5 分钟重来）。

### Gap 6: 流式 tool call 断开无恢复

**影响**: MCP stdio 连接断开后 client 不自动重连。需要重启整个 session。

**优先级**: Phase 2。与 retry (Gap 1) 同类运行时可靠性问题。

### 缺口优先级排序

| 排名 | 缺口 | 优先级 | 当前计划 | 建议调整 |
|------|------|--------|---------|---------|
| 1 | Retry/backoff | **P1 最优先** | H-19 Phase 1 (依赖 H-01) | **解耦 H-01，立即实现** |
| 2 | Agent loop | **P2 early** | 未明确（Phase 2 AgentRunner 一笔带过） | **Phase 2 新增独立工作项** |
| 3 | Structured tracing | **P2 mid** | Phase 2 全链路 trace_id | **保持，对齐 OTel span 格式** |
| 4 | Durable execution | **P2 late** | 未明确 | **Phase 2 late 新增工作项** |
| 5 | MCP reconnect | **P2** | 未明确 | **与 retry 同期实现** |
| 6 | Eval framework | **P3** | 未计划 | **Phase 3 新增** |

---

## Task 3: Agent Framework 决策修订

### 原决策 (2026-02-25 框架调研后)

> 不引入外部框架。对齐 MCP / A2A / OpenTelemetry 三个标准。Track PydanticAI for Phase 5。

### 修订后决策

**核心原则不变**: 不引入外部 agent framework。理由仍然成立——evidence-first contract 是非协商的，没有框架支持它。

**但需要修正优先级排序**:

1. **TS Agent Loop**: 基于 Anthropic SDK `messages.create()` 自建 thin AgentRunner。~200 LOC。不用 Mastra（太年轻）。Phase 2 NEW-R15-impl 之后紧接实现。

2. **Python Agent Loop**: **不实现**。Python 编排器 (hep-autoresearch) 是退役目标。在其上投入 agent loop 开发是浪费。当前通过 CLI runner (claude/gemini/codex) 的 tool use 循环已经工作。

3. **混合策略**: 确认 "SDK 管 model interaction, 自建管 domain state" 的分层:
   - Model SDK (Anthropic SDK / Google Gen AI) → message 构建、token 管理、tool call 解析
   - 自建 AgentRunner → tool dispatch、state machine transition、approval gates
   - 自建 RunManifest → artifact 管理、ledger、checkpoint

4. **OpenTelemetry 对齐**: 从 Phase 2 提前到 Phase 1 late (只采用 span 数据模型，不引入完整 OTel SDK):
   ```typescript
   interface Span {
     trace_id: string;     // UUID v4
     span_id: string;      // UUID v4
     parent_span_id?: string;
     name: string;         // e.g., "inspire_search"
     start_time: string;   // ISO 8601
     end_time?: string;
     status: 'ok' | 'error';
     attributes: Record<string, string | number | boolean>;
   }
   ```

5. **PydanticAI 评估**: 从 Phase 5 提前到 **Phase 3** 作为有时间框定的评估。如果 Python 侧还有存续组件（idea-engine TS 迁移如果延迟），PydanticAI 的 durable execution 可用于 Python 侧长 run 管理。

6. **A2A**: 保持 Phase 4 NEW-07。目前只有一个编排器 + 一个 MCP server，agent-to-agent 通信是假想需求。

---

## Task 4: 修订建议汇总

### 4.1 修订后的 Phase 1 项目清单

**Phase 1A (最优先 — 运行时可靠性)**:

| 项目 | 动作 | 变更说明 |
|------|------|---------|
| H-19 | **提前 + 解耦** | 不依赖 H-01。直接在 `McpStdioClient.call_tool_json()` 中添加 retry/backoff。基于 MCP error text 中的 `RATE_LIMIT` / `UPSTREAM_ERROR` 判断。~50 LOC。 |
| H-13 | keep | 上下文截断。保持原位。 |

**Phase 1B (核心抽象 — 简化版)**:

| 项目 | 动作 | 变更说明 |
|------|------|---------|
| H-01 | **simplify** | 不创建独立 AutoresearchError 信封。在现有 `McpError` 中添加 `retryable` + `retry_after_ms` 字段。保留 JSON Schema 以备 Phase 2 扩展，但 Phase 1 不做 codegen。 |
| H-02 | **simplify** | Phase 1 只在 dispatcher 中生成 trace_id (UUID v4) 并注入 tool result。不做跨组件传播（留给 Phase 2）。 |
| H-04 | **simplify** | 5 个 gate 用 `const GATES = ['A1','A2','A3','A4','A5'] as const` + `validateGate()` 函数。~20 LOC。不做 GateSpec 类型。 |
| M-22 | **defer → Phase 3** | GateSpec 泛化在 Phase 3 引入非 approval gate 时再做。 |
| H-17 | **defer → Phase 2** | CI 检查已覆盖。运行时握手在多版本并存时才有价值。 |
| M-01 | **simplify** | 约定写入 ECOSYSTEM_DEV_CONTRACT，不做 CI lint 脚本。 |
| NEW-R09 | **cut** | Python orchestrator 退役目标，不拆分。 |

**Phase 1C (保持不变)**:
- H-15a (已实现), H-18 (已实现), H-03 (已实现), H-16a (已实现), NEW-01 (已实现), H-11a (已实现)
- M-18 配置管理, M-19 CI 集成测试, M-14a 日志脱敏
- NEW-R02, NEW-R04
- UX-01, UX-05, UX-06

### 4.2 新增运行时基础设施项

| 新项目 ID | Phase | 内容 | 估计 LOC | 依赖 |
|-----------|-------|------|---------|------|
| **NEW-RT-01** | Phase 2 early | Thin AgentRunner (TS): Anthropic SDK `messages.create` + tool dispatch loop + max_turns + error handling | ~200 | NEW-R15-impl |
| **NEW-RT-02** | Phase 2 early | MCP StdioClient reconnect: 检测断连 + 自动重启 + 恢复 pending calls | ~100 | H-19 |
| **NEW-RT-03** | Phase 2 mid | OTel-aligned Span tracing: Span 数据模型 + JSONL writer + dispatcher 集成 | ~150 | H-02 |
| **NEW-RT-04** | Phase 2 late | Durable execution: RunManifest `last_completed_step` + `resume_from` 完善 | ~200 | NEW-RT-01 |
| **NEW-RT-05** | Phase 3 | Eval framework: agent-level 端到端评估基础设施 | ~500 | NEW-RT-01, NEW-RT-03 |

### 4.3 SDK 引入建议

| SDK | 用途 | Phase | 集成方式 |
|-----|------|-------|---------|
| **Anthropic SDK** (`@anthropic-ai/sdk`) | AgentRunner 的 model interaction 层 | Phase 2 | 已安装。用 `messages.create()` + tool call handling。 |
| **OpenTelemetry Semantic Conventions** | Span 数据模型参考（不安装 OTel SDK） | Phase 2 | 参考 spec，手写 Span interface (~20 LOC)。只用数据模型，不用 SDK。 |
| **PydanticAI** | Python 侧 durable execution 评估 | Phase 3 | 时间框定评估。如果 Python 组件仍活跃，spike 1 个 writing run。 |

**明确不引入**:
- Mastra (TS agent framework): 太年轻，API 不稳定
- LangGraph: Python-only，强绑定 LangChain 生态
- Google ADK: Python-only，强绑定 Google 模型
- OpenAI Agents SDK: Python-only，强绑定 OpenAI 模型

### 4.4 对 Batch 2 Prompt 的修订建议

当前 `prompt-phase1-impl-batch2.md` 计划实现 H-15a + H-18 + H-03 + H-04 + H-01。

**建议修订**:

1. **H-15a, H-18, H-03**: 已在 Batch 1 session 中实现（见 git status: 文件已存在但未提交）。Batch 2 应集成测试并提交，不需重新实现。

2. **H-04**: **简化**。不做 `GateSpec` 类型 + `GateRegistry`。改为:
   ```typescript
   // packages/shared/src/gates.ts
   export const GATES = ['A1', 'A2', 'A3', 'A4', 'A5'] as const;
   export type GateId = typeof GATES[number];
   export function isValidGate(id: string): id is GateId {
     return GATES.includes(id as GateId);
   }
   ```
   ~15 LOC 替代原 REDESIGN_PLAN 中的 schema + registry + validation 三件套。

3. **H-01**: **简化**。不创建独立错误信封。在 `packages/shared/src/errors.ts` 的 `McpError` 工厂函数中添加 `retryable` 字段:
   ```typescript
   export function rateLimit(message: string, retryAfterMs?: number) {
     return McpError('RATE_LIMIT', message, { retryable: true, retry_after_ms: retryAfterMs });
   }
   ```

4. **新增 H-19 到 Batch 2**: 将 retry/backoff 作为 Batch 2 最优先项。在 `McpStdioClient.call_tool_json()` 中实现。

### 4.5 已实现项的诚实评估

Prompt 要求诚实，即使对已实现的东西：

| 已实现项 | 过度工程化程度 | 说明 |
|----------|---------------|------|
| **H-16a (83 个常量)** | 低 | 常量化是正确的做法。唯一可商榷的是 `as const` 断言的冗余性——TypeScript 的 `const` 变量已经是 literal type。但这是 style 不是 engineering 问题。 |
| **H-11a (risk map)** | 低 | 83 个工具的风险分级是合理的。`_RAW_TOOL_SPECS.map()` injection pattern 增加一层间接性，但避免了修改 67+ 个 tool spec 文件。权衡合理。 |
| **H-15a (EcosystemId)** | **中-高** | Branded type 在无外部用户系统中无必要。前缀注册表是恒等映射。4 个函数 + 1 个自定义 Error 类对 `prefix_opaque` 格式来说工具太多。但: 已实现、已测试、成本已沉没。保留但冻结。 |
| **H-18 (ArtifactRef)** | 低 | 轻量构造函数。适中。 |
| **H-03 (RunState)** | 低 | Legacy 映射表必要。适中。 |
| **NEW-01 (codegen)** | 低 | 管线本身是必要的。唯一过度的是对 `if-then-allOf` 的特殊处理——strip before compilation——但这是工具限制的 workaround，不是过度设计。 |

---

## 附录: REDESIGN_PLAN 净项数变化

| 度量 | 变更前 | 变更后 | 变化 |
|------|--------|--------|------|
| Phase 1 项数 | 25 | 22 | -3 (cut 2, defer 1) |
| Phase 2 项数 | 27 | 28 | +1 (新增 4 RT, defer 入 3, defer 出 1 VIZ) |
| Phase 3 项数 | 12 | 17 | +5 (接收 defer: M-22, M-20, NEW-VIZ-01, 新增 RT-05, PydanticAI eval) |
| 总净项数 | 119 | 122 | +3 (净增 5 NEW-RT, cut 2) |

**关键变化不是数量而是优先级**: 运行时可靠性项 (retry, agent loop, tracing, durable execution) 从隐含的 "Phase 2 顺带做" 变成有独立 ID、明确依赖关系、可追踪的工作项。
