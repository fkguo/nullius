# Prompt: NEW-05a Stage 3b — Sentinel Files + Timeout Enforcement + Checkpoint Command + Plan Derivation

> 本 prompt 用于新开 Claude Code 对话。
> 工作目录: `/home/user/Coding/Agents/autoresearch-lab/`（monorepo）
>
> **Serena 项目**: `autoresearch-lab`（已配置，onboarding 记忆已就绪）
> **启动前必读 Serena 记忆**: `architecture-decisions`, `dual-model-review-protocol`

---

## 上下文

NEW-05a TS orchestrator 迁移，Stage 1（读操作）+ Stage 2（写操作）+ Stage 3a（checkpoint + requestApproval）已完成。

- **51 tests pass**（36 Stage 1-2 + 15 Stage 3a）
- **Stage 3a R2 双模型 CONVERGED**（Codex xhigh + Gemini）
- Git commit: `ae9de8b`
- Tracker stage: `stage_3a_complete`

Stage 3a 留下的 deferral 项（本阶段需解决的）：
- **`.pause` / `.stop` sentinel 文件**: Python `cmd_pause` 创建 `.pause`，`cmd_resume` 删除，`_check_stop_pause` 检查
- **`paused_from_status` 跟踪**: Python `cmd_pause` 保存原始状态，`cmd_resume` 恢复
- **Plan 验证 + plan.md 渲染**: Python `save_state()` 内置 plan validation + markdown derivation

其他需要从 Python 移植的运行时操作：
- **`check_approval_timeout` 强制执行版**: Stage 1 的 `isApprovalTimedOut` 是只读检查；Python 版会 mutate state（block/reject/escalate）
- **`check_approval_budget` 强制执行版**: Stage 1 的 `isApprovalBudgetExhausted` 是只读检查；Python 版会 mutate state
- **`cmd_checkpoint` 完整实现**: 合并 timeout enforcement + budget check + step tracking + timestamp update

## Stage 3b 范围

在 `packages/orchestrator/src/state-manager.ts` 和 `packages/orchestrator/src/types.ts` 中新增，对齐 Python SSOT。

### 1. Sentinel 文件管理

Python SSOT: `orchestrator_cli.py` → `_check_stop_pause()` (L1675-1680), `cmd_pause()` (L728-749), `cmd_resume()` (L752-780), `cmd_reject()` (L1641-1672)。

文件位置: `.pause` / `.stop` 在 **repo root**（不在 `.autoresearch/` 内）。

需要实现:
- `checkStopPause()`: 检查 `.pause` / `.stop` sentinel 文件是否存在；返回 `'stop' | 'pause' | null`
- `writePauseSentinel()`: 创建 `.pause` 文件（内容 `"paused\n"`）
- `removePauseSentinel()`: 删除 `.pause` 文件（best-effort）
- 修改 `pauseRun`: 调用 `writePauseSentinel()` + 保存 `paused_from_status`
- 修改 `resumeRun`: 调用 `removePauseSentinel()` + 从 `paused_from_status` 恢复原始状态
- 修改 `rejectRun`: 调用 `writePauseSentinel()`（匹配 Python `cmd_reject`）

### 2. `paused_from_status` 追踪

Python SSOT: `cmd_pause()` (L736) 和 `cmd_resume()` (L766-767)。

- 在 `RunState` 类型中添加 `paused_from_status?: RunStatus`（Python 用 pop/setdefault，TS 用 optional field）
- `pauseRun`: 如果当前状态不是 `paused`，保存 `state.paused_from_status = state.run_status`
- `resumeRun`: 读取 `state.paused_from_status` 恢复状态，然后清除该字段
- `defaultState()`: 不含此字段（Python 也不含，按需出现）

### 3. Approval Timeout 强制执行

Python SSOT: `orchestrator_state.py` → `check_approval_timeout()` (L702-766)。

Stage 1 的 `isApprovalTimedOut(state)` 是只读判断。现需实现 **side-effectful** 版本：

- `enforceApprovalTimeout(state)`: 返回 `string | null`（on_timeout action 或 null）
  - 检查 `pending_approval.timeout_at` 是否已过期
  - 如果未过期：return null（无操作）
  - 如果过期，按 `on_timeout` 策略执行：
    - `'reject'`: 设置 `run_status = 'rejected'`，追加 `approval_history` 条目（decision: `'rejected'`），清除 `pending_approval`
    - `'escalate'`: 设置 `run_status = 'needs_recovery'`
    - `'block'` (default): 设置 `run_status = 'blocked'`
  - 写入 state + ledger（event_type: `'approval_timeout'`）

### 4. Approval Budget 强制执行

Python SSOT: `orchestrator_state.py` → `check_approval_budget()` (L769-814)。

Stage 1 的 `isApprovalBudgetExhausted(state)` 是只读判断。现需实现 **side-effectful** 版本：

- `enforceApprovalBudget(state)`: 返回 `boolean`
  - 从 policy 读取 `budgets.max_approvals`
  - 如果 budget 未耗尽：return false
  - 如果耗尽：设置 `run_status = 'blocked'`，清除 `pending_approval`（如有），写入 state + ledger（event_type: `'budget_exhausted'`），return true

### 5. Checkpoint 完整命令

Python SSOT: `orchestrator_cli.py` → `cmd_checkpoint()` (L783-815)。

- `checkpoint(state, opts?)`: 合并所有 checkpoint 逻辑
  - **Status guard**: 仅允许 `running | paused | awaiting_approval`（除非 force）
  - **Timeout enforcement**: 调用 `enforceApprovalTimeout(state)`，如果超时则提前返回
  - **Budget enforcement**: 调用 `enforceApprovalBudget(state)`，如果耗尽则提前返回
  - **Step tracking**: 如果提供 step_id/title，更新 `state.current_step`
  - **Timestamp**: 更新 `state.checkpoints.last_checkpoint_at`
  - **Persist**: state + ledger（event_type: `'checkpoint'`）

### 6. VALID_TRANSITIONS 补充

检查是否需要为新的 timeout enforcement 路径补充状态转换：
- `awaiting_approval → blocked`（on_timeout: block）— 已存在
- `awaiting_approval → rejected`（on_timeout: reject）— 已存在
- `awaiting_approval → needs_recovery`（on_timeout: escalate）— 已存在

## 约束

- **Python 是 SSOT**: 实现前先 `Read` 对应 Python 函数体，逐字段对齐
- **双模型收敛**: 完成后用 Codex (xhigh, 不限时) + Gemini 审核
  - ❌ 绝不 TaskStop 截断审核模型（`dual-model-review-protocol` 记忆有详细说明）
  - ✅ 耐心等待，Codex xhigh 通常需要 10-20 分钟
- **测试**: 每个新方法至少 2 个测试（正常路径 + 错误/边界）
- **增量构建**: 先实现 → 本地 tsc + vitest 通过 → 再提交审核

## 实施顺序建议

1. 读取 Python SSOT（sentinel / timeout / budget / checkpoint 相关函数）
2. 修改 `types.ts`: 添加 `paused_from_status` 到 RunState
3. 实施 §1 sentinel 文件 + §2 paused_from_status
4. 实施 §3 enforceApprovalTimeout + §4 enforceApprovalBudget
5. 实施 §5 checkpoint 命令
6. 写测试（预期 ~20-25 new tests）
7. tsc + vitest 全部通过
8. 双模型收敛审核
9. 更新 tracker + Serena memory + git commit

## 验收标准

- [ ] tsc --noEmit clean
- [ ] vitest 全部通过（预期 ~70-75 tests: 51 existing + ~20-25 new）
- [ ] 双模型收敛（R1 或修正后 Rn）
- [ ] `meta/remediation_tracker_v1.json` NEW-05a note 更新
- [ ] Serena memory `architecture-decisions` 更新
- [ ] git commit

## 参考文件

| 文件 | 用途 |
|------|------|
| `packages/orchestrator/src/state-manager.ts` | 当前 Stage 3a 代码（在此基础上扩展） |
| `packages/orchestrator/src/types.ts` | RunState / ApprovalPolicy 类型定义（需修改） |
| `packages/orchestrator/tests/orchestrator.test.ts` | 当前 51 tests |
| `packages/hep-autoresearch/src/hep_autoresearch/toolkit/orchestrator_state.py` | **Python SSOT** — check_approval_timeout (L702-766), check_approval_budget (L769-814) |
| `packages/hep-autoresearch/src/hep_autoresearch/orchestrator_cli.py` | **Python SSOT** — _check_stop_pause (L1675-1680), cmd_pause (L728-749), cmd_resume (L752-780), cmd_reject (L1641-1672), cmd_checkpoint (L783-815) |
| `meta/docs/orchestrator-mcp-tools-spec.md` | 架构规格 |
| `meta/remediation_tracker_v1.json` | 进度追踪 |

## 不在范围

以下属于后续阶段：
- Plan 验证 + plan.md Markdown 渲染（→ Stage 3c：validate_plan, render_plan_md, write_plan_md, saveState 集成）
- MCP 工具层集成（`orch_run_*` tool registration → NEW-R15-impl）
- Run loop / workflow execution 逻辑
- State locking（→ H-07）
