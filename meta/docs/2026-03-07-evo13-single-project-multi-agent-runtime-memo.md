# EVO-13 单项目多 Agent Runtime 专项设计 Memo

> **日期**: 2026-03-07  
> **目标项**: `EVO-13` — 统一编排引擎 / 单项目内多 Agent 团队执行 runtime  
> **定位**: 设计研究 memo，不是 implementation prompt  
> **目的**: 让未来 `EVO-13` 的 implementation prompt 建立在 `NEW-LOOP-01` 的真实 substrate 之上，避免届时遗忘当前研究结论或重新发明平行状态系统。

## 1. 结论先行

`EVO-13` 的正确角色不是“终于开始多 agent”，而是：

- 把**单项目内多 agent 协作**做成 first-class runtime；
- 严格建立在 `NEW-LOOP-01` 的 `ResearchWorkspace` / task graph / event log substrate 之上；
- 增加 team execution checkpoint、delegation、A2A、agent lifecycle、coordination policy；
- **不得**替换项目状态 SSOT，不得复制第二套平行项目状态。

一句话：

> `NEW-LOOP-01` 负责项目级研究 substrate，`EVO-13` 负责团队执行层；团队执行层扩展 substrate，不能替代 substrate。

---

## 2. `EVO-13` 应解决什么问题

未来 `EVO-13` 应重点解决以下问题：

1. **单项目内多 agent team execution**
   - 一个研究项目中，多个 agent 以角色化方式协作；
   - 例如 literature scout、compute delegate、reviewer、draft improver、consistency checker。

2. **并行与恢复**
   - 团队执行可 checkpoint / restore；
   - 某 agent 失败后可恢复、重分配或继续，而不是整个项目 runtime 丢失状态。

3. **delegation / A2A**
   - agent 间任务委派、回复、回流与可审计事件流；
   - handoff 不能只是 prompt 拼接或聊天转述。

4. **coordination policy**
   - 同一 substrate 上可支持 sequential / parallel / loop / stage-gated / hybrid 协作策略；
   - 但这些都应消费 `ResearchWorkspace` / `ResearchTask` / `ResearchEvent`，而不是另起 workflow 私有状态。

---

## 3. `EVO-13` 明确不应做什么

`EVO-13` 不应：

- 重新定义项目状态 SSOT；
- 用 session transcript 替代 workspace graph；
- 引入社区级 registry / publication / reputation / evolution 逻辑；
- 把 provider/catalog/channel/gateway 机制当成 runtime 核心；
- 反向迫使 `NEW-LOOP-01` 变成完整 team runtime。

---

## 4. 推荐架构

### 4.1 状态分层

建议未来显式分成三层状态：

1. **Project substrate state** — `NEW-LOOP-01`
   - `ResearchWorkspace`
   - `ResearchNode` / `ResearchEdge`
   - `ResearchTask`
   - `ResearchEvent`
   - `ResearchCheckpoint`

2. **Team coordination state** — `EVO-13`
   - team roles
   - delegation graph
   - active agent assignments
   - coordination policy
   - team checkpoint metadata

3. **Session / transcript views**
   - 每个 agent 的对话、日志、短期上下文；
   - 它们可以持久化，但不是项目 SSOT。

### 4.2 核心不变量

- `ResearchWorkspace` 始终是项目状态 SSOT；
- `TeamExecutionState` 只能**引用** workspace nodes/tasks/events；
- 所有 mutation 都必须在项目事件流中可追踪；
- human approval / override / handoff / agent result merge 都应进入结构化事件流。

### 4.3 推荐能力面

未来 `EVO-13` 应优先具备：

- `TeamExecutionState` checkpoint / restore
- typed delegation protocol
- A2A / handoff runtime
- agent lifecycle / health / timeout / cascade stop
- coordination policy engine
- shared audit surface
- 复用 `NEW-LOOP-01` 的 typed handoff surface 与 task injection seam

---

## 5. 与 SOTA 的对齐建议

### 5.1 应 adopt 的模式

- **LangGraph**：durability / interrupt / resume / checkpoint pattern
- **AutoGen**：team patterns + save/load team state
- **OpenAI Agents SDK**：typed handoff + HITL event surface
- **OpenClaw**：subagent layering / queue semantics / pre-flush ideas
- **Google ADK**：sequential / parallel / loop coordination motifs
- **oh-my-opencode Atlas**：6-section delegation protocol、notepad / failure discipline

### 5.2 应 defer 的模式

- `sessions_spawn/send/history` 的完整实现
- per-agent workspace/session store 细节
- full long-term memory platform
- category routing / skill marketplace / provider orchestration
- community registry / paper publication / reputation

### 5.3 应 reject 的模式

- chat transcript 作为 SSOT
- channel/gateway-first 设计
- 为了“多 agent”而牺牲 evidence-first / approval gate / artifact audit
- `EVO-13` 自建第二套 project graph

---

## 6. 与当前本地能力的关系

### 6.1 `research-team` 的位置

`research-team` 应被视为：

- 当前已经存在的高价值 multi-agent workflow 层；
- `EVO-13` 的试验场和桥接层；
- 未来可逐步消费 `ResearchWorkspace` / `ResearchTask` / handoff surface 的上层 workflow。

它**不是** `EVO-13` 的替代品，也不应永远悬浮在统一 runtime 之外。

### 6.2 `NEW-LOOP-01` 的关系

`EVO-13` 的第一性约束应写成：

- 必须建立在 `NEW-LOOP-01` 真实落地后的 substrate 上；
- 若 `NEW-LOOP-01` 尚未稳定，`EVO-13` 只适合做设计研究，不适合写完整 implementation prompt。

---

## 7. 何时应升格为完整 implementation prompt

**不建议现在就写完整 `EVO-13` implementation prompt。**

推荐的触发条件如下：

### 7.1 必须满足的触发条件

1. **`NEW-LOOP-01` 已完成并通过 closeout gate**
   - acceptance commands 通过；
   - `review-swarm` 双审 `0 blocking`；
   - `self-review` `0 blocking`；
   - tracker / memory / `AGENTS.md` 已同步。

2. **`NEW-LOOP-01` 的 substrate 面已经稳定**
   - `ResearchWorkspace` / `ResearchTask` / `ResearchEvent` / `ResearchCheckpoint` 真实落地；
   - `source` / `actor_id` 字段已确定；
   - typed handoff stubs 与任务注入 seam 已确定；
   - 事件/任务/graph 的 outward contract 不再高频抖动。

3. **至少完成一次“team runtime 如何消费 substrate”的本地对齐**
   - 可以是对 `research-team` 的桥接草图；
   - 也可以是 `TeamExecutionState` 与 workspace graph 的映射草案；
   - 但必须明确：team state 引用 substrate，而不是复制 substrate。

### 7.2 不满足时不该写完整 prompt 的情形

- `NEW-LOOP-01` 还只是 types/skeleton，没有真实 runtime；
- `ResearchEvent` / handoff seam / injection seam 还在剧烈变化；
- 对 `research-team` 如何过渡到统一 runtime 仍无本地草图；
- 还在用“社区 vision”替代单项目 team runtime 设计。

### 7.3 实务建议的时点

最合适的时点通常是：

- `NEW-LOOP-01` 完成 closeout 后；
- 下一轮开始真正准备 `EVO-13` 之前；
- 或在 `EVO-01/02/03` 接入开始暴露“需要统一 team runtime”的时候。

也就是说，**`EVO-13` 的完整 implementation prompt 应晚于 `NEW-LOOP-01` 落地，但不必等到社区层启动。**

---

## 8. 如何避免以后遗忘这份 memo

建议采用 **四层防遗忘机制**：

1. **文档层**
   - 本 memo 固定放在 `meta/docs/`；
   - 后续 `EVO-13` formal prompt 必须在“必读文件”中显式列出本文件。

2. **记忆层**
   - 在 `.serena/memories/architecture-decisions.md` 记录：`EVO-13` 应建立在 `NEW-LOOP-01` substrate 上，且完整 prompt 只在触发条件满足后生成。

3. **项目总览层**
   - 在 `AGENTS.md` 中保留单用户/多 agent 三层澄清；
   - 必要时在相关近中期澄清段追加本 memo 路径。

4. **实施 prompt 层**
   - future `NEW-LOOP-01` formal prompt 的“完成汇报 / 下一批建议”中，明确指向本 memo；
   - future `EVO-13` formal prompt 在开头写明：本 prompt 是从本 memo 升格而来。

---

## 9. future `EVO-13` formal prompt skeleton（仅骨架）

未来 `prompt-phase5-impl-evo13.md` 至少应包含：

1. 必读材料（包含本 memo 与 `NEW-LOOP-01` closeout 结果）
2. 范围边界：单项目团队 runtime，不碰社区层
3. 先补 tests / checkpoint fixtures / recovery smoke
4. 子任务拆分：
   - `TeamExecutionState`
   - delegation protocol
   - A2A runtime
   - lifecycle / health / cascade stop
   - `research-team` bridge integration
5. acceptance commands
6. review-swarm + self-review
7. tracker / memory / `AGENTS` 同步

---

## 10. 一句话建议

`EVO-13` 的完整 implementation prompt 应该在 `NEW-LOOP-01` 成熟之后、单项目 substrate 稳定之后再写；而为了不忘记，本 memo 必须被 future `NEW-LOOP-01` closeout 与 future `EVO-13` prompt 双向引用。
