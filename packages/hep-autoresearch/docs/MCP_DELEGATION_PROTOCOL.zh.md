# MCP delegation protocol（与 hep-research-mcp 内置编排工具的委托协议）

目标：避免“重复编排/状态冲突”。当 `hep-research-mcp` 已经提供某些子状态机（例如写作 refinement orchestrator），本项目 Orchestrator 应当在合适粒度上**委托**，并定义清晰的“状态所有权”。

本协议定义：
- 哪些 MCP 工具被视作“orchestrator-semantic tool”
- 外层 Orchestrator 与 MCP orchestrator 的 state ownership/handoff
- 超时/失败/恢复时的处理

## 1) 术语

- **Meta-Orchestrator（本项目）**：面向用户的统一入口（W1/W2/W3/W4）+ 审批/暂停/恢复/导出/账本。
- **MCP orchestrator tool**：一个 MCP 工具本身会推进一个内部循环/状态机（不只是单步 leaf action）。

## 2) “orchestrator-semantic tools” 识别（v0）

在 `tool_mode=standard` 的 72 个工具中，当前明确的 orchestrator-semantic 工具至少包括：

- `hep_run_writing_refinement_orchestrator_v1`：推进写作 refinement 状态机（Review → RevisionPlan → Execute → Verify → Integrate → Repeat）。

随着 `hep-research-mcp` 演进，该列表应当以 tool inventory 为准，并由 Orchestrator 配置显式声明（不要靠字符串猜测）。

## 3) 状态所有权与 handoff（MVP）

原则：同一时刻对同一 `run_id`，只能有一个“写入者”。

### 3.0 排他锁（lock/lease）原语（M1 最小实现）

为避免外层 Orchestrator 与委托的 MCP 子状态机发生并发写入，M1 建议先采用**项目内 lockfile**（不依赖 MCP）：

- 路径：`.autopilot/locks/<run_id>.lock`
- 获取方式：原子创建（或文件锁）；获取失败则 `block`/提示“该 run 正在被占用”
- 内容（建议）：`{ run_id, owner_pid, owner_host, started_at, lease_seconds }`
- 续租：外层 Orchestrator 每个 checkpoint 续租（更新 `started_at`/写入 `last_renewed_at`）
- 过期：超过 `lease_seconds` → 进入 `needs_recovery`，由人类决定是否强制解锁

重要区分：
- 该 lockfile 是 **Meta-Orchestrator 的互斥锁**；
- MCP 侧可能还有自己的 manifest lock（例如 run manifest 写入锁），`hep_run_clear_manifest_lock` 属于“高风险恢复动作”，默认需要人类同意；它**不等价**于这里的互斥锁。

### 3.1 外层 Orchestrator 的职责（永远保留）

- 管理审批（A1–A5）与超时语义（禁止 auto-approve）
- 管理 pause/resume/stop
- 落盘 `.autopilot/state.json` 与 `.autopilot/ledger.jsonl`
- 记录 MCP 调用（工具名、参数、返回的 artifact pointers）

### 3.2 委托时的状态切换

当进入一个“可委托阶段”（例如 W3 写作闭环）：

1) Meta-Orchestrator 写入 state：
   - `run_status=running`
   - `current_step=DELEGATE:MCP:<tool_name>`
   - `delegation={ tool_name, params, started_at }`
2) Meta-Orchestrator 获取 `run_id` 排他锁（实现建议：文件锁/lockfile；写入 ledger）
3) 调用 MCP tool（例如 `hep_run_writing_refinement_orchestrator_v1`）
4) MCP tool 返回后：
   - Meta-Orchestrator 释放锁
   - 将 MCP 返回的关键 artifact pointers 写入 state（与 ledger）
   - 进入下一步（可能继续委托、或回到外层步骤）

### 3.3 冲突避免（必须）

- Meta-Orchestrator 在委托执行期间，不得并行调用任何会修改同一 `run_id` 的 MCP 工具。
- 如用户重复发起同一 `run_id` 的 `run/resume`：
  - 默认 `block` 并提示“已有运行占用该 run_id；请等待/或手动 pause/abort”。

## 4) 超时与失败语义（MVP）

### 4.1 MCP 调用超时

Meta-Orchestrator 必须为委托调用设置一个超时（可配置）：

- 超时后将 `run_status` 置为 `needs_recovery`
- 记录到 ledger：
  - tool_name/params/started_at/timeout_at
  - 已产生 artifacts（若可获得）

### 4.2 崩溃恢复

若重启后发现：
- `current_step` 是 `DELEGATE:MCP:*` 且距离 `started_at` 超过阈值：
  - 进入 `needs_recovery`
  - 要求人类选择：
    - 继续等待（如果 MCP 仍在跑）
    - 终止并回滚（如果可回滚）
    - 重新委托（通常需要检查 run manifest lock）

> 注意：`hep_run_clear_manifest_lock` 属于“高风险恢复动作”，默认需要人类同意，并把理由写入 ledger。

## 5) 可测试验收标准（MVP）

- DP-1（排他性）：同一 `run_id` 的两次并发委托，必须序列化或显式失败（不得产生交错写入）。
- DP-2（可恢复）：在委托中途 kill 外层 Orchestrator，重启后能进入 `needs_recovery` 并给出可选动作。
- DP-3（账本完整）：每次委托调用与返回都写入 ledger（含 tool_name/params 与关键返回指针）。

补充（M1 建议至少做成脚本级验收）：
- DP-1a（锁行为）：当 `.autopilot/locks/<run_id>.lock` 存在时，任何尝试对同一 `run_id` 启动新的委托/写入必须被拒绝或阻塞，并输出可操作提示（如何 pause/abort/恢复）。
