# 单用户项目内多 Agent Runtime：SOTA 对齐与 Autoresearch 架构建议

> **日期**: 2026-03-07  
> **范围**: 单用户、单项目、可多 agent 协作的研究运行时  
> **目的**: 站在整个项目高度，澄清 `NEW-LOOP-01`、`EVO-13`、`EVO-15/16` 的分工，并给出“如何对齐 SOTA、又不丢掉我们自己的 evidence-first 架构”的建议。

## 1. 结论先行

### 1.1 `single-user` 不等于 `single-agent`

Autoresearch 的近中期主产品应理解为：

- **单一人类 owner / principal investigator / 治理控制面单一**；
- 但同一个 research project 内，未来**完全可以有多个 agent 协作**；
- 社区化只是更外层：多个研究团队并行存在，而不是“第一次出现多 agent 的地方”。

因此，项目的正确三层结构应为：

1. **`NEW-LOOP-01`**：单用户、单项目 research loop substrate；
2. **`EVO-13`**：单项目内多 agent 团队执行 runtime；
3. **`EVO-15/16`**：社区级多团队基础设施与自治实验。

### 1.2 项目级核心建议

Autoresearch 若要对齐当前 SOTA，又不变成“chat-first agent demo”，应坚持以下总原则：

- **workspace-first，而不是 session-first**；
- **研究对象图谱 / 事件日志是 SSOT**，不是对话 transcript；
- **agent 是可替换执行者，workspace 才是真实项目状态**；
- **interactive / autonomous 必须共享同一 substrate**；
- **团队执行与社区基础设施都应建立在单项目 substrate 之上，而不是另起状态平行宇宙**。

### 1.3 这轮调研的主要判断

- `NEW-LOOP-01` **不应**直接实现完整 multi-agent runtime；
- 但 `NEW-LOOP-01` **必须**为单项目内多 agent 留出正确扩展面；
- `EVO-13` 才是“单项目内多 agent”变成 first-class runtime 的位置；
- 现在就应该研究这层 SOTA，因为它直接决定 `NEW-LOOP-01` 的边界与未来兼容性。

---

## 2. 这件事在整个项目中的位置

### 2.1 已有本地能力

Autoresearch 已有 **workflow 级多 agent 协作能力**，主要体现在 `research-team`：

- `peer` / `leader` / `asymmetric` 三种协作模式；
- clean-room / convergence gate / membrane 等高质量验证模式；
- 但它们**尚不是统一的项目级持久化 runtime substrate**。

也就是说：

- **已有多 agent workflow**；
- **尚无统一的单项目多 agent runtime substrate**；
- 这正是 `NEW-LOOP-01` → `EVO-13` 要衔接的空档。

### 2.2 正确的演进链

建议明确采用以下演进链：

- **现在**：`research-team` 作为已有 multi-agent workflow 能力，继续提供高价值验证/协作；
- **Phase 3**：`NEW-LOOP-01` 把单项目 substrate 做出来；
- **Phase 5**：`EVO-13` 把 team execution runtime 建在 `NEW-LOOP-01` 之上；
- **更后层**：`EVO-15/16` 把多个研究团队接到社区基础设施上。

因此，项目主线不是“先单 agent，之后直接跳到社区”，而是：

**单项目 substrate → 单项目团队 runtime → 社区级多团队**。

---

## 3. 外部 SOTA 调研：哪些值得借，哪些不该搬

本节只看**单项目内多 agent runtime**真正相关的部分，不泛化到聊天渠道、社区运营或 provider/catalog 细节。

### 3.1 OpenClaw：最值得借的是 agent runtime 形态，不是 chat 壳层

OpenClaw 当前最有价值的部分是：

- 每个 agent 拥有自己的 `workspace` / `agentDir` / `session` 语义边界；
- 存在 `sessions_spawn` / `sessions_send` / `sessions_history` 这类 subagent / A2A 能力；
- 有 queue mode（例如 `collect` / `steer` / `followup`）与队列控制；
- 在 memory / compaction / pre-flush 上形成了完整 runtime 习惯。

**对 Autoresearch 的启发**：

- A2A / delegation / followup 不是社区才需要，而是单项目团队 runtime 就需要；
- 但 OpenClaw 更偏 **session/chat-first runtime**，而 Autoresearch 必须坚持 **workspace-first research runtime**；
- 所以我们更适合**借 runtime pattern，不借对象边界原样**。

**建议**：

- 借：queue/intervention 语义、subagent 生命周期分层、pre-flush / compaction 思想；
- 不借：把 session transcript 或 per-agent chat history 当项目状态 SSOT；
- defer 到 `EVO-13`：`sessions_spawn/send/history` 的真正可运行实现；
- 可映射到 `NEW-LOOP-01`：研究特定的 `LoopIntervention` 语义，而不是 chat queue mode 原样照搬。

### 3.2 LangGraph：最值得借的是 durability / interrupt / persistence substrate

LangGraph 的核心价值不在“多智能体花样”，而在：

- **checkpointer/thread** 模型；
- interrupt / resume / human-in-the-loop；
- persistence 作为 memory、fault-tolerance、time-travel 的基础。

**对 Autoresearch 的启发**：

- 单项目 research runtime 必须可恢复、可中断、可审计；
- 这些能力不是团队层的可选增强，而是 substrate 的基本要求；
- 但 LangGraph 的泛状态图不是研究域 SSOT，我们不能用 generic state bag 替代 `ResearchWorkspace` / `ResearchEvent`。

**建议**：

- 借：checkpointer / interrupt / resume 的耐久性模式；
- 不借：generic graph/state 直接替代研究域对象；
- `NEW-LOOP-01` 就应吸收：append-only event log + checkpoint restore 的最小版本；
- `EVO-13` 再把 team execution checkpoint 建在其上。

### 3.3 AutoGen：最值得借的是 team pattern 与 save/load state

AutoGen 的强项是把团队协作做成 first-class：

- `SelectorGroupChat`、`Swarm`、`GraphFlow` 等不同团队编排模式；
- `save_state` / `load_state` 让 team runtime 可恢复；
- 允许 nested teams / graph workflow / selector-based role switching。

**对 Autoresearch 的启发**：

- “一个项目内一个 agent 团队”完全是主流模式，不是远期幻想；
- 团队状态本身必须能 checkpoint/restore；
- 但 team state 不能变成平行主状态，仍应**引用 workspace graph**。

**建议**：

- `EVO-13` 应明确做 `TeamExecutionState`；
- 但它必须**引用** `ResearchWorkspace` 节点/任务，而不是复制一份平行状态；
- `NEW-LOOP-01` 只需把 future team runtime 需要的 handoff / task injection 面预留好。

### 3.4 OpenAI Agents SDK：最值得借的是 typed handoff 与审计事件流

OpenAI Agents SDK 在这一问题上的价值主要是：

- `handoffs` 作为明确的 agent-to-agent 转移面；
- human-in-the-loop / tool approval 可进入统一事件流；
- `sessions` 提供会话层状态抽象，但不强迫它成为业务 SSOT。

**对 Autoresearch 的启发**：

- 单项目多 agent 不能只靠“互相发字符串”；
- 应该存在**typed handoff contract**，至少区分 compute / review / literature / writing 之类 delegation 类型；
- 审批与 handoff 都应该进入可审计事件流，而不是只出现在聊天 transcript 里。

**建议**：

- `NEW-LOOP-01` 先定义 typed handoff stubs；
- `EVO-13` 再接入真正的 A2A 运行时；
- approval / handoff / intervention 均应形成结构化事件。

### 3.5 Google ADK：最值得借的是 workflow motif 与 shared state 思路

Google ADK 对我们有两个价值：

- Sequential / Parallel / Loop agent 这些 workflow motif 很实用；
- session/state 作为共享工作上下文，而不是仅靠 prompt 传球。

**对 Autoresearch 的启发**：

- `EVO-13` 的 team coordination policy 可以显式支持 sequential / parallel / loop / staged variants；
- 但我们的共享状态不应停在 session dict，而应是 research-specific workspace graph。

### 3.6 CrewAI：更像对持久流程的提醒，而不是主架构模板

CrewAI Flows 强调：

- stateful flow；
- restart/resume；
- 流程级 durability。

**启发**：

- 流程 durability 已是行业基本盘；
- 但其 business-process 气质较强，不适合作为 Autoresearch 研究内核的对象模型模板。

---

## 4. 对 Autoresearch 的项目级建议

### 4.1 必须坚持的架构不变量

1. **`ResearchWorkspace` 是项目状态 SSOT**
   - session 只是视图；
   - agent 只是执行者；
   - artifacts / evidence / task graph / event log 才是研究状态本体。

2. **所有高层 runtime 都只能扩展 substrate，不得替代 substrate**
   - `EVO-13` 应建立在 `NEW-LOOP-01` 之上；
   - `EVO-15/16` 应建立在 `EVO-13` 之上；
   - 任何层都不应重新发明自己的状态主轴。

3. **interactive / autonomous 不能分裂成两套 runtime**
   - 区别只能在 policy；
   - 共享同一任务图、事件流、checkpoint、handoff surface。

4. **evidence-first / approval-gated / artifact-auditable 不可妥协**
   - 这不是外围治理，而是 runtime 设计约束本身。

### 4.2 建议纳入 `NEW-LOOP-01` 的内容

`NEW-LOOP-01` 不是 team runtime，但应至少纳入以下内容：

1. **workspace-first 研究对象模型**
   - `ResearchWorkspace`
   - `ResearchNode` / `ResearchEdge`
   - `ResearchTask`
   - `ResearchEvent`
   - `ResearchCheckpoint`
   - `LoopIntervention`

2. **append-only 事件流 + 最小 checkpoint**
   - 先支持 durable event log + checkpoint restore；
   - 不必一步到位做长期 memory 平台。

3. **事件/任务字段为未来多 agent 留钩子**
   - 建议至少有：
     - `source: 'user' | 'agent' | 'system'`
     - `actor_id?: string | null`
   - 这在单 agent/单用户模式下也有审计价值，并避免未来 schema 升级打断兼容性。

4. **typed handoff stubs**
   - 至少定义：
     - `ComputeHandoff`
     - `ReviewHandoff`
     - `LiteratureHandoff`
     - 可选 `WritingHandoff`
   - 这里只定义接口与 payload，不实现 `sessions_spawn/send/history`。

5. **外部任务注入入口**
   - 至少存在一个 typed `injectTask(...)` / `appendDelegatedTask(...)` 之类的扩展点；
   - 让 `EVO-13` 未来能往 workspace/task graph 注入任务，而不必 subclass substrate。

6. **研究特定 intervention taxonomy**
   - 可借鉴 OpenClaw 的 queue modes 思想，但改写为研究语义，例如：
     - `collect_more_evidence`
     - `steer_direction`
     - `followup_compute`
     - `request_human_override`
     - `request_review`

### 4.3 建议现在就确定、但不一定现在全量实现的内容

1. **未来的 single-writer / mutation authority 粒度**
   - 正确粒度更可能是 `workspace node` / `artifact target` / `task target`；
   - 而不是 session 或全 run 粗粒度锁；
   - 但如果 `NEW-LOOP-01` 当前并不做真实并行执行，不必为此过度工程化出完整 actor queue。

2. **team runtime 与 substrate 的引用关系**
   - `TeamExecutionState` 将来必须引用 workspace nodes/tasks；
   - 不应复制一份平行 team graph 作为第二主状态。

3. **research-team 的桥接路径**
   - 现有 `research-team` 可作为过渡期 multi-agent 协作能力；
   - 长远上，它应成为消费 `ResearchWorkspace` / `ResearchTask` / handoff surfaces 的上层 workflow，而不是永远游离在 substrate 之外。

### 4.4 应 defer 到 `EVO-13` 的内容

以下更适合进入 `EVO-13`：

- full A2A / `sessions_spawn/send/history`
- nested delegation / announce chain / cascade stop
- per-agent workspace / session store
- team checkpoint / restore / heartbeat / health / lifecycle
- structured delegation protocol（6-section work order）
- notepad / cross-task team knowledge memory
- category routing / agent specialization policy
- 多 agent 并行执行时的真正 actor queue / coordination policy engine

### 4.5 原则上应 reject 的内容

以下不应成为 `NEW-LOOP-01` 或 `EVO-13` 的主导对象模型：

- chat transcript 作为研究状态 SSOT
- channel / gateway-specific 机制
- provider/profile failover 细节主导 runtime 设计
- 复制 OpenClaw 的 per-agent 对象边界而不做 research-domain 重构
- 为 interactive / autonomous 各造一套 runtime
- 把社区级 registry / publication / reputation 逻辑提前压进单项目 runtime

---

## 5. 对当前计划项的具体建议

### 5.1 对 `NEW-LOOP-01`

建议 future formal prompt 明确要求：

- 真的落地 runtime substrate，而不只是 types；
- event log 是 append-only；
- checkpoint 有最小 restore 能力；
- 事件含 `source` 与可空 `actor_id`；
- 存在 typed handoff stubs 与外部任务注入入口；
- 明确 scope boundary：不做 full multi-agent runtime。

### 5.2 对 `EVO-13`

建议在设计上显式补一条约束：

- **`EVO-13` 必须建立在 `NEW-LOOP-01` workspace/task/event substrate 之上**；
- 不得引入平行 project state；
- 团队状态只能扩展 coordination 层，而不是替代研究对象层。

### 5.3 对 `research-team`

建议把它视为：

- 现阶段已有的高价值 multi-agent workflow layer；
- 不是未来统一 runtime 的替代品；
- 而是 `NEW-LOOP-01` / `EVO-13` 成熟前的桥接层与评估试验场。

---

## 6. 独立模型协助结果

本轮专项调研还请了两位外部 reviewer 做独立判断：

- **Claude Opus**：`CONVERGED_WITH_AMENDMENTS`, `0 blocking`
- **Kimi K2.5（OpenCode）**：`CONVERGED_WITH_AMENDMENTS`, `0 blocking`

二者共同支持以下核心判断：

- 三层分工是对的；
- `NEW-LOOP-01` 应是 workspace-first substrate；
- `EVO-13` 应负责单项目内多 agent team execution；
- `EVO-15/16` 才是社区级多团队层；
- `NEW-LOOP-01` 应为未来多 agent 留出 schema/runtime seam，但不能提前把 team runtime 混进去。

它们提出的高价值 amendment 中，我认为最值得吸收进后续 prompt/设计的是：

- 在事件/任务层加入 `source` 与可空 `actor_id`；
- 给 `NEW-LOOP-01` 明确外部任务注入入口；
- 在 `EVO-13` 中明确“引用 workspace graph，而不是复制第二套状态”。

---

## 7. 最终建议

如果目标是让 Autoresearch 在“单用户项目内多 agent 协作”上达到 honest SOTA，而不是只做会聊天的 agent demo，那么最重要的不是先把多少 subagents 跑起来，而是先守住这条主轴：

> **项目级研究状态必须先被做对；agent 团队只是消费并扩展这个状态，而不是重新定义它。**

因此，推荐路线是：

1. 继续保持 `NEW-LOOP-01` 的 substrate 角色；
2. 让它为未来 team runtime 预留 typed seam；
3. 把单项目多 agent 的真正运行时集中到 `EVO-13`；
4. 让社区基础设施继续后置到 `EVO-15/16`；
5. 在此过程中，把现有 `research-team` 作为过渡期 multi-agent bridge，而不是另起一套不可整合的平行体系。

这条路线既对齐当前主流 runtime SOTA，也保持了 Autoresearch 自己的 research-first / evidence-first / audit-first 身份。

---

## 8. 参考来源（官方/一手为主）

- OpenClaw Concepts — Multi-Agent: <https://docs.openclaw.ai/concepts/multi-agent>
- OpenClaw Concepts — Session Tool: <https://docs.openclaw.ai/concepts/session-tool>
- OpenClaw Concepts — Queue: <https://docs.openclaw.ai/concepts/queue>
- OpenClaw Concepts — Memory: <https://docs.openclaw.ai/concepts/memory>
- OpenClaw Concepts — Compaction: <https://docs.openclaw.ai/concepts/compaction>
- LangGraph JS — Persistence: <https://docs.langchain.com/oss/javascript/langgraph/persistence>
- LangGraph JS — Interrupts: <https://docs.langchain.com/oss/javascript/langgraph/interrupts>
- LangGraph Supervisor (JS): <https://langchain-ai.github.io/langgraphjs/reference/modules/langgraph-supervisor.html>
- AutoGen — Teams: <https://microsoft.github.io/autogen/stable/user-guide/agentchat-user-guide/tutorial/teams.html>
- AutoGen — Selector Group Chat: <https://microsoft.github.io/autogen/stable/user-guide/agentchat-user-guide/tutorial/selector-group-chat.html>
- AutoGen — GraphFlow: <https://microsoft.github.io/autogen/stable/user-guide/agentchat-user-guide/tutorial/graph-flow.html>
- AutoGen — State / Save & Load: <https://microsoft.github.io/autogen/dev/user-guide/agentchat-user-guide/tutorial/state.html>
- OpenAI Agents JS — Agents: <https://openai.github.io/openai-agents-js/guides/agents/>
- OpenAI Agents JS — Sessions: <https://openai.github.io/openai-agents-js/guides/sessions/>
- OpenAI Agents JS — Human in the Loop: <https://openai.github.io/openai-agents-js/guides/human-in-the-loop/>
- Google ADK — Multi-Agents: <https://google.github.io/adk-docs/agents/multi-agents/>
- Google ADK — Workflow Agents: <https://google.github.io/adk-docs/agents/workflow-agents/>
- Google ADK — Sessions: <https://google.github.io/adk-docs/sessions/>
- CrewAI — Flows: <https://docs.crewai.com/concepts/flows>
