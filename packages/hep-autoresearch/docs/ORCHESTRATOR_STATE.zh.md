# Orchestrator state contract（状态持久化与恢复契约）

目标：把 `pause/resume/status/approve` 做成**可恢复、可审计、可回滚**的工程能力，而不是“靠对话记忆”。

本文件定义 Orchestrator 的**最小状态机 + 落盘格式 + crash recovery 语义**，用于实现与评测（M1 的硬依赖之一）。

## 1) 状态落盘的最小集合（MVP）

建议在项目根目录写入：

- `.autopilot/state.json`：**当前运行态**（单文件，易调试；后续可替换为 sqlite）
- `.autopilot/ledger.jsonl`：**append-only 事件账本**（每次 gate/执行/失败都写一条）

> 账本用于“可审计”，`state.json` 用于“可恢复”。二者职责不同。

## 2) 最小状态机（MVP）

`run_status`（建议枚举）：

- `idle`：未运行
- `running`：正在执行
- `paused`：用户手动暂停（或 watchdog 暂停）
- `awaiting_approval`：正在等待 A1–A5 审批（默认不得自动继续）
- `completed`：完成
- `failed`：失败并停止（有失败原因与回滚指针）
- `needs_recovery`：检测到 crash/超时，需要人类确认恢复策略

允许的关键跃迁（示意）：

- `running -> awaiting_approval`（触发 gate）
- `awaiting_approval -> running`（approve）
- `awaiting_approval -> paused`（reject 或人工暂停）
- `running -> needs_recovery`（watchdog 检测到 checkpoint 超时/进程崩溃后重启）
- `needs_recovery -> running|paused|failed`（人类选择恢复/暂停/终止）

## 3) `.autopilot/state.json` schema（v1）

建议字段（最小可用）：

```json
{
  "schema_version": 1,
  "run_id": "M1-r1",
  "workflow_id": "W1_ingest",
  "run_status": "awaiting_approval",
  "current_step": {
    "step_id": "W1.S3",
    "title": "Expand literature search",
    "started_at": "2026-02-01T00:00:00Z"
  },
  "checkpoints": {
    "last_checkpoint_at": "2026-02-01T00:00:00Z",
    "checkpoint_interval_seconds": 900
  },
  "pending_approval": {
    "approval_id": "A1-0003",
    "category": "A1",
    "requested_at": "2026-02-01T00:00:00Z",
    "timeout_at": "2026-02-02T00:00:00Z",
    "on_timeout": "block",
    "packet_path": "artifacts/runs/M1-r1/approvals/A1-0003/packet.md"
  },
  "budgets": {
    "max_network_calls": 200,
    "max_runtime_minutes": 60,
    "network_calls_used": 17,
    "runtime_minutes_used": 12
  },
  "artifacts": {
    "run_card": "artifacts/runs/M1-r1/run_card.json",
    "run_card_sha256": "<sha256>",
    "latest_manifest": "artifacts/runs/M1-r1/manifest.json",
    "latest_summary": "artifacts/runs/M1-r1/summary.json",
    "latest_analysis": "artifacts/runs/M1-r1/analysis.json"
  },
  "notes": "Human-readable status line"
}
```

约束：

- `state.json` 必须做到**幂等可写**：每次写入应为完整替换（避免部分写入导致损坏）；建议写临时文件再 rename。
- 对会修改 state/ledger 的命令，应在 `.autopilot/state.lock` 上持有 advisory lock 以避免并发写入竞争（POSIX `flock`；在缺少该机制的平台上，不支持并发写入）。
- `packet_path` 必须指向**可审阅审批包**（见 `docs/APPROVAL_GATES.md`），且审批包需要可离线审阅。
- `artifacts.run_card` 必须指向每个 run 的 run-card（`artifacts/runs/<run_id>/run_card.json`），`run_card_sha256` 用于把审批/manifest 绑定到“将要执行的意图”（注意：这里的 sha256 是对 canonical JSON（排序 key、紧凑分隔符）计算的哈希，不是对磁盘上 pretty-printed 文件字节做 `sha256sum`）。

## 4) Timeout 语义（必须明确，默认不能“沉默即同意”）

任何 `pending_approval` 都必须定义 `on_timeout`，并满足：

- **禁止** `auto_approve`（沉默不等于同意）
- 默认 `on_timeout = block`：继续保持 `awaiting_approval`，并在 `status` 中显示“已超时，需要人类处理”
- 可选策略（未来实现）：`reject` / `escalate`（都必须写入 ledger）

## 5) Crash recovery 语义（MVP）

当 Orchestrator 启动时：

- 若 `run_status == running` 且 `now - last_checkpoint_at > 2 * checkpoint_interval_seconds`：
  - 自动把 `run_status` 改为 `needs_recovery`
  - 并要求人类选择：
    - `resume`（从最近 checkpoint 继续）
    - `pause`（保持暂停，等待人工处理）
    - `abort`（标记 failed，并写明原因）

Plan（计划）语义（补充）：

- `current_step.step_id` 必须是 `plan.steps[*].step_id` 之一。
- `plan.current_step_id` 与 `current_step.step_id` 保持镜像（恢复语义由 state 驱动，而不是由对话驱动）。
- `plan_md_path` 是派生视图（每次 plan 更新时确定性重写）。
- `plan.branching`（可选）用于记录“可回溯”的备选路径（branch candidates）：
  - 同一时刻只能有一个 active branch：`plan.branching.active_branch_id`。
  - `plan.branching.active_branch_id` 是复合 id：`"<decision_id>:<branch_id>"`（例如 `"W2.S1:b3"`）。
  - `branch_decision.active_branch_id` 是该 decision 内的裸 `branch_id`（例如 `"b3"`）。
  - 默认限制分支爆炸：`plan.branching.max_branches_per_decision = 5`（提高 cap 必须显式，并在 Plan SSOT + ledger 中留下记录）。

## 6) Ledger（append-only）最小字段（v1）

每条事件建议包含：

- `ts`（UTC）
- `event_type`：`run_started|step_started|step_completed|approval_requested|approval_approved|approval_rejected|paused|resumed|checkpoint|failed|recovered|branch_candidate_added|branch_switched`
- `run_id/workflow_id/step_id`（如适用）
- `details`（小对象：原因、预算、artifact 指针、hash）

> ledger 用于审计与回归分析；不要把大对象塞进 ledger。
