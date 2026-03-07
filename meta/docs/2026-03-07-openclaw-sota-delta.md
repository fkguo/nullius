# OpenClaw 2026-03 SOTA Delta for Autoresearch

> **日期**: 2026-03-07
> **目的**: 在 `meta/docs/2026-02-19-opencode-openclaw-design-adoption.md` 的基础上，补充 2026-03 官方 OpenClaw repo/docs 中对当前 Phase 3 与后续 `NEW-LOOP-01` / `EVO-13` 最有价值的差分结论。本文聚焦 **现在可直接影响 prompt / architecture sequencing 的内容**，不重复 2 月调研已经覆盖的基础概念。

## 1. 为什么需要这份 delta

2 月的 adoption note 已经覆盖 OpenCode / OpenClaw / oh-my-opencode 的主要模式，但当时 OpenClaw 还不是今天这种规模。到 2026-03-07，我复核到：

- `openclaw/openclaw` GitHub stars 约 **272k**、MIT；
- 2026-03-03 发布 **`v2026.3.2`**；
- 官方 docs 已明显把主线收敛到 **gateway control plane + isolated agents + session/memory/runtime substrate**。

因此，本次 delta 的重点不是“OpenClaw 有多火”，而是：**哪些模式现在已足够成熟，应该约束我们近期 prompt；哪些应明确留给后续 runtime lane。**

## 2. 对 `NEW-RT-07` 最相关的结论

### 2.1 Host owns routing authority

OpenClaw 当前官方架构与模型路由文档都明确体现：

- server/gateway 持有 model routing authority；
- 执行面只发送稳定 metadata / request context；
- route 选择、fallback、profile rotation、cooldown 等都属于 host/runtime 的治理面。

**对 Autoresearch 的影响**:

- `NEW-RT-07` 应继续坚持 **server 只发稳定 metadata，host resolve route**；
- 不应允许 `hep-mcp` 等 server 读取 routing config 或直接输出“请用某某模型”。

### 2.2 Route policy 与 auth/profile failover 必须分层

OpenClaw 官方 docs 已把以下两层拆开：

1. **route / model policy**（primary + fallbacks）
2. **provider 内 auth profile rotation / cooldown / disabled billing profile**

**对 Autoresearch 的影响**:

- `NEW-RT-07` 本批应实现 **sampling routing registry + fallback chain + audit**；
- 不应在本批顺手扩成完整 auth/profile failover 子系统；
- 但 route 结构要为未来 provider/profile failover 留出扩展点。

### 2.3 Route / fallback attempts 必须可审计

OpenClaw 现在很重视 route / failover / auth 状态的可观测性，而不是只给最终“成功/失败”。

**对 Autoresearch 的影响**:

- `NEW-RT-07` prompt 中必须要求记录：
  - input metadata
  - resolved route key
  - chosen backend/model
  - fallback attempts
  - final selected route/model
  - fail-closed reason

这应成为 tests + review + self-review 的明确证据面。

## 3. 对 `NEW-LOOP-01` / `EVO-13` 更关键的结论

### 3.1 Per-agent workspace / state / sessions 三分是高价值模式

OpenClaw 的多 agent 路由和 workspace 文档已经把以下边界做得很清楚：

- **workspace**：工作目录 / memory / skills / persona files
- **agent state dir**：auth profiles、model registry、per-agent config
- **session store**：chat history + routing state

**对 Autoresearch 的影响**:

- 这更像 `NEW-LOOP-01` / `EVO-13` 的 substrate 设计参考；
- 不建议把这三分提前塞进 `NEW-RT-07`。

### 3.2 Session actor queue / keyed async queue 是最值得直接借的代码形态

OpenClaw 的：

- `src/plugin-sdk/keyed-async-queue.ts`
- `src/acp/control-plane/session-actor-queue.ts`

都是 **短小、纯粹、可 clean-room 近似复写** 的实现。

**对 Autoresearch 的影响**:

- 这类代码比大而全的 gateway/runtime 框架更适合作为 `NEW-LOOP-01` / unified orchestrator 的直接参考；
- 若后续需要真正实现 per-session single-writer / actor queue，可优先参考这两个文件的模式。

### 3.3 Session tools / A2A substrate 应留给 loop/runtime，不要提前混进 routing

OpenClaw 的 `sessions_list/history/send/spawn`、announce chain、agent-to-agent ping-pong，是典型的 runtime substrate。

**对 Autoresearch 的影响**:

- 这些能力非常值得未来采纳；
- 但它们属于 `NEW-LOOP-01` / `EVO-13` / peer-review orchestration，不应混入 `NEW-RT-07`。

### 3.4 Plain Markdown memory + pre-compaction memory flush 适合 future loop，不适合当前 RT-07

OpenClaw 把记忆 SoT 放在 workspace Markdown，并提供：

- `memory/YYYY-MM-DD.md`
- `MEMORY.md`
- `memory_search`
- pre-compaction memory flush

**对 Autoresearch 的影响**:

- 这是非常好的单用户长期运行 substrate 设计；
- 但当前更适合放在 `NEW-LOOP-01` / Phase 5 compaction & memory lane，而不是 `NEW-RT-07`。

## 4. 哪些东西现在可以“拿过来”

### 4.1 可以直接借模式，甚至 clean-room 近似复写

- keyed async queue
- session actor queue
- route policy 与 auth/profile failover 的分层边界
- route/fallback observability contract

### 4.2 只建议借模式，不建议整块搬

- model failover 整体实现
- compaction pipeline
- full gateway/session tooling
- ClawHub registry backend

原因：这些模块与 OpenClaw 的网关/渠道/插件/runtime 绑定更深，直接搬进来会让 Autoresearch 的近期 work item 失焦。

## 5. 对 prompt sequencing 的结论

### 5.1 `NEW-RT-07` 仍然应该 standalone

经过 2026-03 官方资料复核，结论没有变：

- `NEW-RT-07` 应继续独立完成；
- 但 prompt 必须补强：
  - host-owned routing authority
  - route policy vs auth/profile failover 分层
  - route/fallback audit

### 5.2 `NEW-LOOP-01` 才是吸收 OpenClaw 主体价值的地方

如果后续做 `NEW-LOOP-01`，应把 OpenClaw 作为一等参考系重新开一轮更聚焦的调研，重点放在：

- session actor queue
- isolated agent workspace / state / sessions
- session tools / A2A send/spawn
- memory + pre-compaction flush
- queue mode / lane scheduling

## 6. 是否还需要再做一次大调研？

**结论**: 对 `NEW-RT-07` 来说，**暂时不需要再做一轮“大而全”的 OpenClaw 调研**。

原因：

- 当前对 `RT-07` 真正高价值的 surfaces 已经覆盖；
- 继续扩大范围，多半会把 attention 拉到 `NEW-LOOP-01` / `EVO-13`，反而削弱 `RT-07` 的 scope discipline。

但当我们正式准备 `NEW-LOOP-01` prompt 时，**应再开一轮专门针对 OpenClaw runtime/session substrate 的 follow-up 调研**。

## 7. 供后续 prompt 直接复用的简版结论

- `NEW-RT-07`: 学 OpenClaw 的 **host-owned routing + auditable fallback + strict route/auth separation**。
- `NEW-LOOP-01`: 学 OpenClaw 的 **session actor queue + isolated workspace/state/session store + A2A session tools + memory flush**。
- 不要把后者提前混入前者。
