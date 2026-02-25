# Prompt: Scope Audit — 过度工程化 vs 欠工程化 重新评估

> 本 prompt 用于新开 Claude Code 对话。
> 工作目录: `/home/user/Coding/Agents/autoresearch-lab/`（monorepo）
>
> **Serena 项目**: `autoresearch-lab`（已配置，onboarding 记忆已就绪）
> **启动前必读 Serena 记忆**: `architecture-decisions`（特别是最后一条 "Agent Framework Landscape" 条目）

---

## 背景

在 Phase 1 Batch 2 准备执行期间，对 10 个主流 agent 框架进行了系统调研（详见 `meta/docs/research-agent-framework-landscape.md`）。调研的初始结论是"不引入外部框架，对齐 MCP/A2A/OpenTelemetry 三个标准"。

但进一步反思发现一个更深层的问题：**系统同时存在过度工程化和欠工程化**。

### 过度工程化迹象

- `EcosystemId` branded type + prefix registry + validation — UUID 字符串加前缀就够了
- `GateSpec` 类型 + `GateRegistry` + 编译时唯一性校验 — 5 个 gate 写个 enum 即可
- `_RAW_TOOL_SPECS.map()` injection pattern — 巧妙但增加间接性
- 119 项 REDESIGN_PLAN 跨 5 个 Phase — 规划本身的维护成本已经很高
- 无向后兼容负担的系统却在做 branded types、前缀注册表、gate 抽象

### 欠工程化的地方（大公司 SDK 重点解决的）

- **没有 agent loop 抽象** — 完全依赖 Claude Code / Gemini CLI 的 tool use 循环
- **没有 retry/backoff** — MCP stdio client 是 fire-and-forget
- **没有 structured tracing** — 出问题时很难诊断
- **没有 eval framework** — 无法系统性验证 agent 行为退化
- **没有 durable execution** — 长 run 崩溃就丢了
- **流式 tool call 断开无恢复**
- **Zod parse 失败的 recovery** 全靠手写 next_actions

### 核心命题

> 我们在类型系统层面精雕细琢，却在运行时可靠性层面几乎是裸奔。

---

## 任务

### Task 1: 审计现有 REDESIGN_PLAN

**输入**: `meta/REDESIGN_PLAN.md`（119 项）

**对每个 Phase 1-2 项目评估**:
1. **必要性**: 这个抽象解决了真实问题还是假想问题？
2. **复杂度 vs 收益**: 简单方案（enum、plain string、直接 if/else）是否足够？
3. **结论**: `keep` (保持) / `simplify` (简化) / `defer` (延后) / `cut` (砍掉)

特别审查以下项目：
- H-15a EcosystemID — branded type 是否过度？plain `string` + 验证函数是否足够？
- H-04 Gate Registry — GateSpec 类型 + registry 是否过度？enum + validate 函数是否足够？
- H-18 ArtifactRef V1 — 手写构造/验证辅助是否过度？直接用 generated type 是否足够？
- H-01 AutoresearchError — 错误信封是否过度？McpError 已经在用了

### Task 2: 识别真正的运行时缺口

**输入**:
- `meta/docs/research-agent-framework-landscape.md` — 框架调研
- `packages/hep-mcp/src/tools/dispatcher.ts` — 当前 dispatch 逻辑
- `packages/orchestrator/src/` — TS orchestrator scaffold
- `packages/hep-autoresearch/src/hep_autoresearch/toolkit/mcp_stdio_client.py` — Python MCP client

**对每个缺口评估**:
1. **影响**: 缺少这个能力时，实际会在什么场景崩溃？
2. **自建 vs SDK**: 用现有 SDK（Anthropic SDK / PydanticAI / Mastra）能否直接获得？
3. **优先级**: 比 Phase 1 类型抽象更紧迫还是更不紧迫？

重点评估的缺口：
- Agent loop (tool use → retry → continue)
- Retry/backoff for MCP calls
- Durable execution (checkpoint/resume across crashes)
- Structured tracing (OpenTelemetry spans)
- Eval framework (agent behavior regression testing)

### Task 3: 修订 Agent Framework 决策

基于 Task 1 和 Task 2 的结果，重新评估：

1. **TS agent loop**: 是否应该直接用 Anthropic SDK 的 `messages.create` + tool handling，而非自建 AgentRunner？或者评估 Mastra 的 agent loop？
2. **Python agent loop**: PydanticAI 的 `Agent.run()` 是否应该成为 Python 侧的标准 agent loop？
3. **混合策略**: 是否可以"SDK 管 agent loop + 自建管 domain state"，各取所长？

### Task 4: 产出修订建议

基于以上分析，产出：

1. **修订后的 Phase 1-2 项目清单** — 标注 keep/simplify/defer/cut + 理由
2. **新增运行时基础设施项** — 如 retry、tracing、eval，插入正确的 Phase
3. **SDK 引入建议** — 具体哪些 SDK、用哪些部分、怎么集成
4. **更新 `meta/docs/research-agent-framework-landscape.md`** §4 Decision 和 §5 Impact 章节
5. **更新 Serena memory `architecture-decisions`** — 追加 scope audit 结论

---

## 约束

- **不要直接修改 REDESIGN_PLAN.md** — 本 session 只产出建议，人类确认后再改
- **不要执行代码变更** — 纯分析和规划
- **诚实优先** — 如果某个已实现的东西（如 H-16a 83 个常量、H-11a risk map）也存在过度工程化，直说
- **考虑实际使用场景** — 不是"理论上需要"而是"实际跑起来会不会崩/会不会卡"
- **Batch2 继续执行不受影响** — 本审计针对 Phase 1 剩余项和 Phase 2+ 策略

---

## 完成后

1. 产出 scope audit 报告（可写入 `meta/docs/scope-audit-phase1-2.md`）
2. 更新 `meta/docs/research-agent-framework-landscape.md` 的决策章节
3. 更新 Serena memory `architecture-decisions`
4. 列出对 `prompt-phase1-impl-batch2.md` 的修订建议（如有）
