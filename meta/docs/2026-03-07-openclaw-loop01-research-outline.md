# NEW-LOOP-01 OpenClaw 专项调研设计

> **日期**: 2026-03-07
> **目标项**: `NEW-LOOP-01` — Single-User Research Loop Runtime
> **定位**: Phase 3 前置运行时专项调研，不是实现 prompt，也不是实现代码
> **用途**: 为后续 `NEW-LOOP-01` 实施准备提供边界、证据面、设计映射、验收骨架
>
> **公开面清理说明（2026-04）**: 文中凡涉及已删除的 `meta/REDESIGN_PLAN.md`、`meta/remediation_tracker_v1.json`、`meta/docs/prompts/*` 路径，均应按“历史上下文”理解，不再作为当前公开仓 authority。

## 1. 结论先行

**结论：需要比 `NEW-RT-07` 明显更细，而且必须细到“可直接生成 formal implementation prompt”的程度。**

原因不是 `NEW-LOOP-01` 更大而已，而是它会直接决定近中期执行内核的最小 substrate：

1. **runtime substrate**：从线性阶段流转转向 event/task graph；
2. **workspace / run / session / agent 边界**：哪些状态属于项目，哪些属于单次执行，哪些只是对话壳层；
3. **single-writer / actor queue**：如何避免同一研究对象、同一 artifact、同一工作空间被并发污染；
4. **interactive / autonomous 同底座**：不能演化成两套 runtime；
5. **subagent / A2A 接入点**：哪些在 `NEW-LOOP-01` 只做接口，哪些要等 `EVO-13`；
6. **checkpoint / memory / compaction**：哪些应落为最小研究循环能力，哪些必须后置。

所以本专项调研不是“OpenClaw 导读”，而是一次 **runtime-architecture mapping + scope-boundary decision**。

---

## 2. 本轮调研的最终交付物

本轮完成后，至少要沉淀以下 5 份产物：

1. **OpenClaw → Autoresearch 设计映射表**
   - 每个关键概念给出 `adopt now / defer / reject` 决策；
   - 明确归属到 `NEW-LOOP-01`、`EVO-13`、或更晚阶段。
2. **最小 runtime contract 草案**
   - 明确 `ResearchWorkspace`、`ResearchTask`、`ResearchEvent`、`ResearchCheckpoint` 等最小抽象；
   - 标注哪些是借鉴模式，哪些是研究域特有抽象。
3. **边界决议 memo**
   - 明确 `NEW-LOOP-01` 与 `RT-07`、`NEW-DISC-01`、`NEW-SEM-06b/d/e`、`EVO-13` 的分工；
   - 明确哪些“像 OpenClaw”的东西本轮禁止实现。
4. **实现前验证骨架**
   - 针对 future prompt 预写 test-first / smoke-first / acceptance skeleton；
   - 明确哪些测试先于实现，哪些 smoke path 必须可展示。
5. **formal prompt skeleton**
   - 形成足够具体的实现 prompt 章节结构、必读清单、验收命令和 review 要点。

---

## 3. 本专项调研要回答的核心问题

### 3.1 Runtime substrate

必须回答：

- OpenClaw 当前如何建模 `session`、`followup turn`、`background work`、`queue mode`、`actor queue`？
- 这些概念与我们未来的 `ResearchWorkspace` / `ResearchTask` / `ResearchEvent` / `LoopIntervention` 哪些可映射，哪些只属于 chat/gateway 语境？
- 我们需要的最小 substrate 是“session-first”还是“workspace-first”？

### 3.2 Workspace / state / session 分层

必须回答：

- OpenClaw 的 `workspace`、`agentDir`、`sessions` 各自解决了什么问题？
- 在 Autoresearch 中，哪些对应 project/workspace，哪些对应 orchestrator control-plane state，哪些对应 run/session transcript？
- `NEW-LOOP-01` 需要的持久层最小到什么程度，才不会过早滑入 `EVO-13` 的统一编排器设计？

### 3.3 Single-writer / actor queue

必须回答：

- `KeyedAsyncQueue` / `SessionActorQueue` 的 single-writer 语义在 OpenClaw 的哪一层成立？
- 对 Autoresearch 而言，single-writer 应该落在：workspace、research-task、artifact、node，还是其中某一组合？
- `NEW-RT-01` 的 lane queue 与 OpenClaw actor queue 有哪些同构点、哪些关键缺口？

### 3.4 Followup / interruption / queue mode semantics

必须回答：

- OpenClaw 的 `collect` / `steer` / `followup` / `steer-backlog` 语义，哪些可以 clean-room 转译到研究循环？
- 研究循环中的 `review issue 注入`、`新证据追补`、`compute failure 回跳`、`人工 override` 分别需要什么事件语义？
- 哪些模式值得借鉴，哪些只是渠道层问题的副产物？

### 3.5 Subagent / A2A substrate

必须回答：

- `sessions_spawn` / `sessions_send` / `sessions_history` 的约束与生命周期是什么？
- 在我们的语境中，peer review、computation delegation、literature delegation 是否都需要同一种 substrate？
- `NEW-LOOP-01` 是否只需定义 typed handoff interface，而把真实 multi-agent runtime 留给 `EVO-13`？

### 3.6 Memory / checkpoint / compaction

必须回答：

- OpenClaw 的 memory、memory search、pre-compaction flush 里，哪些对单研究者 loop 真正高价值？
- `NEW-LOOP-01` 应该先落什么：checkpoint、summary、decision log、task ledger、working memory flush？
- 哪些一旦提前引入，就会把本项膨胀成长期记忆系统？

---

## 4. 初步决策假设（带着问题去验证）

本轮调研应验证以下假设是否成立；若被证伪，应在最终 memo 中显式写明：

1. **应采纳的更可能是模式，而不是 OpenClaw 的对象边界原样照搬**。
2. **`NEW-LOOP-01` 更可能是 workspace-first / task-first substrate，而不是 session-first substrate**。
3. **single-writer 队列很可能值得借，但粒度未必是 session，而更可能是 research-task / workspace node**。
4. **subagent / A2A 真实运行时大概率应 defer 到 `EVO-13`，但 `NEW-LOOP-01` 需要预留 typed handoff surface**。
5. **memory/compaction 在 `NEW-LOOP-01` 应只落最小 checkpoint/summary 能力，不能提前变成长期知识库系统**。
6. **渠道/网关/provider failover/技能市场等 OpenClaw 能力，原则上不应进入 `NEW-LOOP-01` 正式实现 prompt**。

---

## 5. 一手证据面（2026-03）

### 5.1 OpenClaw 官方 docs

优先读取：

1. `docs/concepts/architecture.md`
2. `docs/concepts/multi-agent.md`
3. `docs/concepts/agent-workspace.md`
4. `docs/concepts/session.md`
5. `docs/concepts/session-tool.md`
6. `docs/concepts/queue.md`
7. `docs/concepts/memory.md`
8. `docs/concepts/compaction.md`
9. `docs/concepts/model-failover.md`（只读 runtime/failover boundary）
10. `docs/channels/broadcast-groups.md`（只读 followup / fan-out 语义）
11. `docs/gateway/protocol.md`
12. `docs/gateway/configuration-reference.md`（只读 queue/routing/isolation）

### 5.2 OpenClaw 关键源码

优先读取：

1. `src/plugin-sdk/keyed-async-queue.ts`
2. `src/acp/control-plane/session-actor-queue.ts`
3. `src/acp/session.ts`
4. `src/acp/session-mapper.ts`
5. `src/acp/runtime/session-identifiers.ts`
6. `src/agents/openclaw-tools.sessions*.ts`
7. `src/agents/compaction.ts`
8. `src/agents/memory-search.ts`
9. `src/agents/model-selection.ts`
10. `src/agents/model-fallback.ts`

### 5.3 本仓库中的锚点

必须对读：

1. `meta/docs/2026-02-19-opencode-openclaw-design-adoption.md`
2. `meta/docs/2026-03-07-openclaw-sota-delta.md`
3. `meta/docs/sota-monorepo-architecture-2026-03-06.md`
4. `docs/ARCHITECTURE.md` 与 `docs/PROJECT_STATUS.md` 中当前 front-door / runtime 边界
5. `meta/front_door_authority_map_v1.json` 与 `meta/ECOSYSTEM_DEV_CONTRACT.md` 中现行 authority 映射
6. `packages/orchestrator/src/agent-runner.ts`
7. `packages/orchestrator/tests/agent-runner.test.ts`
8. 若后续已存在：`packages/orchestrator/src/research-loop*.ts`

### 5.4 证据优先级

优先级固定为：

1. OpenClaw 当前官方 docs / 当前源码
2. 我们已有 adoption / SOTA 文档
3. 本仓库现有 runtime 与测试形态
4. 次级评论或外部讨论

若官方 docs 与旧 adoption 文档冲突，以 **2026-03 当前 docs/源码** 为准，并在 memo 中记录 drift。

---

## 6. 设计映射表应采用的字段

最终映射表至少包含以下列：

- `OpenClaw concept / file`
- `OpenClaw solves what problem`
- `Autoresearch analogous problem`
- `Adopt now in NEW-LOOP-01 / Defer to EVO-13 / Reject`
- `If adopt: clean-room pattern or direct code candidate`
- `Required guards / risks`
- `Rationale`

其中 **`If adopt`** 这一列必须谨慎：

- 默认策略应是 **clean-room 借模式，不直接搬代码**；
- 只有在确认为小型、通用、许可证兼容、且不会把对象边界一起错误搬入时，才可把某些局部实现列为 direct-code candidate；
- 若未完成许可证与归属核查，则必须先保持 `clean-room pattern`。

---

## 7. `NEW-LOOP-01` 的建议边界（调研目标态）

本轮调研应尽量把 future prompt 收束到以下边界：

### 7.1 应优先落在 `NEW-LOOP-01` 的内容

- `ResearchWorkspace` / task graph / event log 最小抽象
- 合法回跳路径建模：`compute -> literature|idea`、`review -> evidence_search`、`finding -> draft_update`
- interactive / autonomous 共享 substrate
- 最小 checkpoint / summary / intervention surface
- 与 `EVO-01/02/03` 对接所需的 typed handoff surface

### 7.2 更可能应 defer 到 `EVO-13` 的内容

- 真正的 multi-agent runtime
- `sessions_spawn/send/history` 的完整可运行语义
- per-agent workspace / session store / announce chain
- 长期 memory search / compaction runtime
- category routing / skill registry / provider orchestration

### 7.3 原则上应 reject 的内容

- chat channel / gateway-specific 机制
- provider catalog / auth failover 细节
- 以 session transcript 取代 workspace graph 作为研究状态 SSOT
- 任何会把 `NEW-LOOP-01` 偷偷扩成“统一编排引擎”的设计

---

## 8. 本专项调研的明确非目标

以下内容不应在本轮扩散：

- 回头重做 `NEW-RT-07`
- 提前启动 `NEW-DISC-01` D4/D5
- 启动 `NEW-SEM-06b/d/e`
- 提前实现 `EVO-13`
- 把 OpenClaw 的 channel/gateway/provider/ClawHub 叙事搬进 loop prompt
- 直接写 `NEW-LOOP-01` 代码

---

## 9. 推荐调研顺序

1. **先读 docs**：澄清当前 OpenClaw 的概念边界；
2. **再读最小关键源码**：只抓 queue、session、memory、compaction、session tools；
3. **再做本仓库映射**：对照 `NEW-LOOP-01` / `EVO-13` / orchestrator 现状；
4. **最后产出决策包**：映射表、runtime contract、边界决议、formal prompt skeleton。

禁止一开始就陷入源码细枝末节，也禁止把调研写成泛泛的 SOTA 综述。

---

## 10. formal prompt skeleton 预期至少包含什么

未来 `prompt-phase3-impl-new-loop01.md` 至少应包含：

1. 先决门禁（读物、GitNexus、tracker 更新、scope boundary）
2. OpenClaw 结论摘要（只保留与 runtime substrate 有关部分）
3. 先补 tests / smoke fixtures / baselines 的顺序
4. 实现子任务拆分（workspace graph、event runtime、dual mode、handoff stubs）
5. 明确非目标
6. acceptance commands
7. review-swarm + self-review 要求
8. tracker / memory / AGENTS 同步要求

也就是说，这轮调研结束后，formal prompt 不应再从零探索架构，只应消费已沉淀的决策包。

---

## 11. 调研完成标准

本专项调研完成，当且仅当：

- 已明确 `NEW-LOOP-01` vs `EVO-13` 的边界；
- 已形成 adopt / defer / reject 决策表；
- 已明确至少一版最小 runtime contract；
- 已预写 future prompt 的 test-first / smoke-first / acceptance skeleton；
- 已明确哪些模式只借语义，哪些局部实现可考虑 clean-room 近似复现；
- 已把范围外内容明确排除，避免 future prompt 膨胀。

---

## 12. 一句话执行建议

`NEW-LOOP-01` 的 OpenClaw 专项调研，**必须比 `NEW-RT-07` 更细，但“细”应集中在 runtime substrate 映射、single-writer 语义、workspace/task/event 边界与 scope discipline 上，而不是扩散到 channel/gateway/provider 杂项。**

---

## 13. 多 Agent 分层澄清（避免把 `single-user` 误读成 `single-agent`）

这次专项调研应明确采用 **三层区分**：

### 13.1 Layer A — 单用户 / 单项目主循环（Phase 3 主干）

这是 `NEW-LOOP-01` 的直接范围：

- 一个研究项目由**单一人类 owner / principal investigator** 主导；
- runtime 先建立 `workspace + task graph + event log + checkpoint + intervention` 的最小 substrate；
- interactive / autonomous 共用同一底座；
- 此层的“single-user”强调 **治理权与主控制平面单一**，不等于未来只能有一个 agent 在工作。

### 13.2 Layer B — 单项目内多 Agent 协作（比社区更近）

这不是遥远愿景，而是更贴近中期产品形态的下一层：

- 同一个 research project 内可存在多个 agent 协作；
- 典型角色包括：literature scout、peer reviewer、compute delegate、draft improver、consistency checker；
- 它们围绕**同一个项目 / workspace / 课题**协作，类似人类课题组内部的小组分工；
- 这一层更适合由 `EVO-13` 承担完整 runtime：team execution checkpoint、分层嵌套 agent、A2A / `sessions_send`、cascade stop、structured delegation。

### 13.3 Layer C — 社区级多团队生态（长期愿景）

这是 `EVO-15` / `EVO-16` 的层级：

- 社区内存在多个 agent research teams；
- 团队之间可以并行选题、合作、竞争、引用彼此结果；
- Agent-arXiv / registry / reputation / integrity / publication/evolution protocol 主要属于这一层。

### 13.4 对本项目的架构结论

因此，Autoresearch 不应只有“单 agent v1”与“社区远景”两档，而应明确存在以下演进链：

1. `NEW-LOOP-01`：单用户 research loop substrate；
2. `EVO-13`：单项目内多 agent 团队执行 runtime；
3. `EVO-15/16`：社区级多团队基础设施与自治实验。

换言之：

- **单研究者系统 ≠ 单 agent 系统**；
- **单项目内多 agent 协作** 应被视为近中期产品层，不只是远景社区层；
- 社区层则是在“项目内团队协作 runtime”之上再增加跨团队基础设施。

这也是为什么 `NEW-LOOP-01` 的调研需要为 future multi-agent collaboration **预留 handoff surface**，但不应在本项里把完整 team runtime 提前做掉。

---

## 14. 设计映射表模板（供专项调研填写）

> 建议把最终映射表做成独立 markdown/json artifact；本节给出最小模板与首批候选行。

### 14.1 表头模板

| OpenClaw concept / file | OpenClaw solves what problem | Autoresearch analogous problem | Candidate layer | Decision | If adopt: clean-room pattern or direct-code candidate | Required guards / risks | Evidence read | Rationale |
|---|---|---|---|---|---|---|---|---|
| `<concept>` | `<problem>` | `<analogous problem>` | `NEW-LOOP-01` / `EVO-13` / `EVO-15+` | `Adopt now` / `Defer` / `Reject` | `clean-room` / `direct-code candidate` / `N/A` | `<risks>` | `<docs/src>` | `<why>` |

### 14.2 首批候选行（建议优先填写）

| OpenClaw concept / file | OpenClaw solves what problem | Autoresearch analogous problem | Candidate layer | Decision | If adopt: clean-room pattern or direct-code candidate | Required guards / risks | Evidence read | Rationale |
|---|---|---|---|---|---|---|---|---|
| `workspace` / `agent-workspace.md` | agent working context + file/state boundary | `ResearchWorkspace` 项目/运行时边界 | `NEW-LOOP-01` | `TBD` | `clean-room` | 不得退化为 session transcript SSOT | docs + local runtime | `<fill>` |
| `session` / `session.md` | turn/thread identity and history | run/session transcript 壳层 | `NEW-LOOP-01` or `EVO-13` | `TBD` | `clean-room` | 不得把 chat 壳层当研究图谱主状态 | docs + source | `<fill>` |
| `KeyedAsyncQueue` | keyed single-writer serialization | per-task / per-node / per-workspace 串行化 | `NEW-LOOP-01` | `TBD` | `clean-room` | 锁粒度错误会导致吞吐或污染 | source | `<fill>` |
| `SessionActorQueue` | session-scoped actor ordering | future team execution / delegated worker ordering | `EVO-13` | `TBD` | `clean-room` | 不得在 loop 项里偷落完整 actor runtime | source | `<fill>` |
| `collect/steer/followup` | interruption and followup control | review issue 注入 / compute failure 回跳 / human override | `NEW-LOOP-01` | `TBD` | `clean-room` | 必须研究语义化，不能照搬 chat mode 命名 | docs | `<fill>` |
| `sessions_spawn/send/history` | subagent spawning + A2A messaging | peer review / compute / literature delegation | `EVO-13` | `TBD` | `clean-room` | Phase 3 只应保留 typed handoff surface | docs + source | `<fill>` |
| `memory search` | retrieve prior distilled knowledge | checkpoint / summary / decision recall | `NEW-LOOP-01` or `EVO-13` | `TBD` | `clean-room` | 禁止提前膨胀为长期 KB 平台 | docs + source | `<fill>` |
| `compaction` | transcript compression / pre-flush | run summary / checkpoint compaction | `EVO-13` or later | `TBD` | `clean-room` | 先厘清 what is compacted：session 还是 workspace event log | docs + source | `<fill>` |
| `model-failover` | provider/profile resiliency | host routing / auth/profile failover | `RT-07` / later infra | `Reject for LOOP-01` | `N/A` | 避免 scope 污染到 routing plane | docs | `<fill>` |
| `broadcast groups` | fan-out over channels | future team fan-out / delegation topology | `EVO-13` or `EVO-15+` | `TBD` | `clean-room` | 不得把 channel layer带入 Phase 3 loop | docs | `<fill>` |

### 14.3 填表规则

- `Candidate layer` 与 `Decision` 必须分开：有些概念候选落点是 `EVO-13`，但最终仍可能 `Reject`。
- `Decision=Adopt now` 时，必须同时写出 **最小落地范围** 与 **显式非目标**。
- `direct-code candidate` 默认极少；如选择该值，必须补许可证/归属核查结论。
- `Evidence read` 至少要指向一个一手来源；不能只写“印象中”。
- 若某行会推动 prompt 扩 scope，优先改成 `Defer`，不要用模糊措辞留口子。

---

## 15. future implementation skeleton 草稿（`NEW-LOOP-01`）

> 这是结构草稿，不代表现在就进入实现。

### 15.1 标题与使命

- 标题：`NEW-LOOP-01 implementation skeleton`
- 使命：在 Phase 3 落地单用户 research loop 的最小 runtime substrate，使研究执行从线性阶段机转为 event/task graph，并为 `EVO-01/02/03` 提供统一 handoff surface。

### 15.2 开工前硬门禁

- 完整读取：`AGENTS.md`、`docs/ARCHITECTURE.md`、`docs/PROJECT_STATUS.md`、`meta/front_door_authority_map_v1.json`、`meta/docs/sota-monorepo-architecture-2026-03-06.md`、`.serena/memories/architecture-decisions.md`、本专项调研文档、相关代码与测试。
- GitNexus：先读 `gitnexus://repo/autoresearch-lab/context`；stale 则先 `npx gitnexus analyze`。
- 状态追踪：通过当前仍在仓的状态文档与源码测试事实同步，不依赖已删除 tracker 路径。
- 范围边界：不得并入 `NEW-DISC-01` D4/D5、`NEW-SEM-06b/d/e`、`RT-07` 返工、`EVO-13` 提前实现。

### 15.3 目标与非目标

**目标**：

- 定义 `ResearchWorkspace` / `ResearchNode` / `ResearchEdge` / `ResearchTask` / `ResearchEvent` / `ResearchCheckpoint` / `LoopIntervention` 最小抽象；
- `ResearchTask` / `ResearchEvent` 至少预留 `source` 与可空 `actor_id`，避免未来 `EVO-13` 触发 schema 重打版本；
- 落地 event/task graph runtime；
- 建模合法回跳；
- 让 interactive / autonomous 共用 substrate；
- 为 `EVO-01/02/03` 提供 typed handoff stubs。

**非目标**：

- 完整 multi-agent runtime；
- `sessions_spawn/send/history` 完整实现；
- provider/category routing、skill registry、community infra；
- 长期 memory search / compaction 平台。

### 15.4 实施顺序（test-first / smoke-first）

1. 先补类型与 runtime 测试骨架；
2. 先补最小 smoke fixture：展示非线性路径；
3. 先锁 acceptance baseline（若有 graph serialization / event log snapshot）；
4. 再写 workspace graph types；
5. 再写 event runtime；
6. 再写 dual-mode policy seam；
7. 最后接 handoff stubs 与 smoke path。

### 15.5 建议子任务拆分

1. **L1 — Workspace graph types**
   - 类型定义与最小校验；
   - node kinds 至少覆盖：question、idea、evidence_set、compute_attempt、finding、draft_section、review_issue、decision。
2. **L2 — Event/task runtime**
   - 事件驱动迁移与 active task 管理；
   - `ResearchEvent` 至少支持 `source: 'user' | 'agent' | 'system'` 与 `actor_id?: string | null`；
   - 不再依赖单一阶段枚举决定全局状态。
3. **L3 — Valid backtrack semantics**
   - 支持 `compute -> literature|idea`、`review -> evidence_search`、`finding -> draft_update`。
4. **L4 — Dual mode on one substrate**
   - interactive / autonomous 仅 policy 不同；共享同一 runtime state。
5. **L5 — Handoff stubs for EVO-01/02/03**
   - 至少提供 compute handoff、feedback handoff、writing/review handoff 的 typed interface stubs；
   - 同时提供最小外部任务注入 seam（如 `injectTask(...)` / `appendDelegatedTask(...)`），供未来 `EVO-13` 团队协调层复用。

### 15.6 先补的测试/fixture/baseline

- `packages/orchestrator/tests/research-loop-types*.test.ts`
- `packages/orchestrator/tests/research-loop-runtime*.test.ts`
- `packages/orchestrator/tests/research-loop-smoke*.test.ts`
- 若有 snapshot/baseline：`packages/orchestrator/tests/fixtures/research-loop/*` 与对应 baseline 文件

测试至少覆盖：

- workspace graph 构造与 node/edge invariant；
- event 驱动下 active tasks 更新；
- `source` / `actor_id` 审计字段与最小序列化；
- 合法回跳路径；
- interactive/autonomous 在同一 substrate 上的行为分歧仅由 policy 驱动；
- handoff stub 的类型边界与最小集成烟雾路径；
- 外部任务注入 seam 不破坏 workspace graph / event log SSOT。

### 15.7 建议 acceptance commands

至少包含：

- `pnpm --filter @autoresearch/orchestrator test`
- `pnpm --filter @autoresearch/orchestrator build`
- `pnpm -r build`
- 若新增跨 package shared contract：补跑相邻 package `test` / `build`

若有专门 smoke 命令或 snapshot gate，应一并列入 formal prompt。

### 15.8 审核要求

- 正式 `review-swarm` 必做，固定 `Opus` + `OpenCode(kimi-for-coding/k2p5)`；
- reviewer 必查：runtime types、关键调用链、event flow、tests、fixtures、baseline、scope boundary；
- 自审必做，且必须显式检查“是否把 `EVO-13` 或社区层内容偷带入”；
- 若任一 reviewer 有 blocking issue，必须修正并继续下一轮直至双审 `0 blocking`。

### 15.9 交付同步

完成前必须同步：

- 受影响的公开 front-door 文档（如 `docs/PROJECT_STATUS.md` / `docs/ARCHITECTURE.md`，若本轮触及）
- `.serena/memories/architecture-decisions.md`
- `AGENTS.md`
- adopted / deferred amendments 及原因

### 15.10 完成汇报最少内容

- 运行时抽象与回跳语义的改动摘要；
- 测试 / smoke / build 验证结果；
- review-swarm 结论；
- self-review 结论；
- commit hash / push 结果；
- 对下一批（大概率 `EVO-13` 或 `EVO-01/02/03` 接入）的建议。
