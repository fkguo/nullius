# EVO-13 Runtime Governance / Control-Plane Amendment

> **日期**: 2026-03-08  
> **目标项**: `EVO-13` — 单项目内多 Agent 团队执行 runtime  
> **性质**: 设计修订草案（amendment），不是 implementation prompt  
> **触发来源**: 对 `edict` 项目的定向深挖（重点看其 runtime governance / control-plane / observability，而非把其整体框架迁入本仓）

## 1. 结论先行

`edict` 对本生态最有价值的，不是其“通用多 agent 框架”身份，而是以下四类能力：

1. **显式 delegation / permission matrix**
2. **operator-facing intervention vocabulary**（例如 pause / resume / cancel / redirect）
3. **live status + replay + health 组成的 control plane**
4. **skills 可见性与 operator 管理面**

这些能力与本仓未来 `EVO-13` 的方向**同向**，但不要求改变当前 `REDESIGN_PLAN` 的主干顺序。

一句话：

> `edict` 值得作为 `EVO-13` 的治理与控制面参考样本，但不值得成为本仓 research substrate / retrieval backbone / evidence-first 架构的模板。

---

## 2. 应吸收的设计增量

### 2.1 显式 delegation permission matrix

未来 `EVO-13` 不应只停留在“支持 typed delegation protocol”，还应显式定义：

- 哪些 role 可以向哪些 role 发起 delegation
- 哪些 task kind 可以跨 role handoff
- 哪些动作允许 agent 自主执行，哪些必须经过 human / owner approval
- 哪些角色拥有 veto / review / redirect / approve 权限

**建议落点**:
- `TeamExecutionState` 中补一层 role/permission policy surface
- future `EVO-13` prompt 的必读材料 / acceptance / review 检查项中，显式加入 permission matrix

### 2.2 Operator intervention vocabulary

`NEW-LOOP-01` 已有 `pause` / `resume` / `redirect` / `inject_task` / `approve` intervention 面；`EVO-13` 应在此基础上明确区分：

- **task-local** intervention
- **team-wide** intervention
- **project-wide** intervention

建议 future `EVO-13` 至少评估以下动作是否需要 first-class 化：

- `pause`
- `resume`
- `redirect`
- `inject_task`
- `approve`
- `cancel`
- `cascade_stop`

其中：
- `cancel` 适合表示任务或委派关系被显式终止，而非仅暂停；
- `cascade_stop` 适合表示上游失败 / owner intervention 触发的团队级联停机，而不是让每个 agent 各自发明失败传播方式。

### 2.3 Live status / replay / audit surface

`edict` 的实时看板、任务回放、健康面板证明：operator-facing control plane 是多 agent runtime 的重要组成部分。

对本仓的正确吸收方式是：

- 将 **live status / replay / intervention surface** 视为 `ResearchEvent` / `TeamExecutionState` 的**只读视图 + 控制入口**；
- 不得把 dashboard / transcript / session view 误当成项目状态 SSOT；
- 所有 intervention、handoff、health transition、checkpoint/restore 都必须可落入结构化事件流并可审计。

### 2.4 Team-local lifecycle / health / timeout / cascade stop

`edict` 的 heartbeat / health monitor 值得吸收，但应按本仓层次拆开：

- **EVO-13**: 单项目内 team-local lifecycle / health / timeout / cascade stop
- **EVO-14**: 跨 run / fleet-level scheduler、全局 agent pool 健康、资源重分配

也就是说：
- `EVO-13` 负责“团队执行过程中某个 delegate 卡死/失联/超时怎么办”；
- `EVO-14` 负责“多个 run 之间如何调度 agent 资源与健康状态”。

### 2.5 Skills 可见性属于 control plane，不属于 runtime 核心

`edict` 的 skills 管理界面说明：operator 很需要看到“哪个 agent 有哪些 skill、版本、来源、状态”。

但本仓应避免把 skill 管理耦合进 `EVO-13` runtime 核心。

正确边界：
- runtime 只消费已注册/已授权的 skill capability；
- skills registry / operator visibility / remote skill lifecycle 应保留在 control-plane / registry / skills-market 方向演进。

---

## 3. 明确不应吸收的部分

以下内容应明确 **reject**：

1. **chat transcript / dashboard state 作为 SSOT**
2. **以 control-plane server 反向主导 runtime state**
3. **为了 dashboard 便利而绕开 workspace/task/event substrate**
4. **把治理隐喻（例如朝廷/部门 metaphor）当成 runtime 的硬编码结构**
5. **把 skill 管理、新闻简报、外部 webhook 等 operator 功能混进 `EVO-13` 核心职责**

`edict` 是一个很好的产品/控制面参考，但不是本仓 research substrate 的 authority。

---

## 4. 对现有重构方案的影响

### 4.1 不需要修改的部分

以下内容**不需要**因为 `edict` 而改变：

- `NEW-LOOP-01` → `EVO-13` → `EVO-15/16` 三层推进顺序
- retrieval / discovery / evidence-first 主线
- canonical paper / rerank / localization / fail-closed 设计
- `NEW-LOOP-01` 作为单项目 substrate SSOT 的定位

### 4.2 建议的小幅修订

建议只做三类文档级修订：

1. 在 `EVO-13` 设计材料中显式加入 **delegation permission matrix** 要求
2. 在 `EVO-13` 设计材料中显式加入 **operator intervention vocabulary** 与 **cascade stop** 要求
3. 在 `REDESIGN_PLAN` 中澄清：
   - `EVO-13` 负责 team-local lifecycle / health / timeout / cascade stop
   - `EVO-14` 负责跨 run / fleet-level 调度与健康管理

换言之：

> 需要的是“分工澄清与能力补钉”，不是 phase 顺序重写。

---

## 5. future `EVO-13` prompt 应额外检查什么

future `EVO-13` implementation prompt 除了既有 memo 中的 checkpoint / delegation / A2A / lifecycle / bridge integration 外，还应显式检查：

1. 是否存在 **delegation permission matrix**，而不只是自由 handoff
2. intervention 是否区分 task-local / team-wide / project-wide 语义
3. `cancel` / `cascade_stop` 是否被明确建模，而不是散落在错误处理里
4. health / stalled / timeout transition 是否进入结构化事件流并可 replay
5. live status / replay / operator dashboard 是否被定义为 **view/control-plane surface**，而不是项目 SSOT
6. skills 可见性是否走 registry / control-plane，而不是耦合进 runtime 核心

---

## 6. 防遗忘策略（本 amendment 自身）

为了保证 future `EVO-13` 实施时不会忘记本草案，必须同时做到：

1. 本草案作为 checked-in 文档保留在 `meta/docs/`
2. 基础 memo `meta/docs/2026-03-07-evo13-single-project-multi-agent-runtime-memo.md` 反向链接本草案
3. `meta/docs/prompts/prompt-phase5-impl-evo13-skeleton.md` 作为 checked-in future formal prompt scaffold 保留
4. `AGENTS.md` 的 `EVO-13` 设计追踪段追加本草案路径
5. `.serena/memories/architecture-decisions.md` 提炼稳定结论
6. `meta/REDESIGN_PLAN.md` 在 `EVO-13` 段落追加本草案链接与 team-local / fleet-level 边界澄清
- 升格流程以 `meta/docs/prompts/prompt-phase5-impl-evo13-skeleton.md` §8 为准。
7. future `EVO-13` formal prompt 的“必读文件”必须同时列出：
   - 基础 memo
   - 本 amendment
   - `meta/docs/prompts/prompt-phase5-impl-evo13-skeleton.md`
   - `NEW-LOOP-01` closeout 结果
8. future `EVO-13` formal prompt 的 review-swarm 与 self-review 检查项必须与本文件 §5 的检查清单逐条对应，并在 review packet 中显式勾选

---

## 7. 一句话建议

把 `edict` 视为 `EVO-13` 的**runtime governance / control-plane 参考样本**：吸收 permission matrix、intervention vocabulary、live status / replay、team-local health/cascade stop；拒绝 transcript-as-SSOT、dashboard-first state、以及任何会削弱 evidence-first / substrate-first 架构的做法。
