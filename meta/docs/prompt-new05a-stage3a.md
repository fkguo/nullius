# Prompt: NEW-05a Stage 3a — Checkpoint + requestApproval

> 本 prompt 用于新开 Claude Code 对话。
> 工作目录: `/home/user/Coding/Agents/autoresearch-lab/`（monorepo）
>
> **Serena 项目**: `autoresearch-lab`（已配置，onboarding 记忆已就绪）
> **启动前必读 Serena 记忆**: `architecture-decisions`, `dual-model-review-protocol`

---

## 上下文

NEW-05a TS orchestrator 迁移，Stage 1（读操作）+ Stage 2（写操作）已完成。

- **36 tests pass**（17 Stage 1 + 17 Stage 2 + 2 B6/B7 guards）
- **R3 双模型 CONVERGED**（Codex xhigh + Gemini，B1-B3 + B6-B7 共 5 个 blocking fix 验证通过）
- Git commit: `baddaa3`

Stage 2 留下的 deferral 项（本阶段需解决的）：
- **Checkpoint heartbeat**: approve/resume 时应更新 `checkpoints.last_checkpoint_at`
- **Ledger detail parity**: Python 在 approval 事件中记录 `category` + `note`；TS 记录 `approval_id` + `from/to`

## Stage 3a 范围

在 `packages/orchestrator/src/state-manager.ts` 中新增，对齐 Python SSOT。

### 1. Checkpoint 管理

Python SSOT: `orchestrator_state.py` → `cmd_checkpoint` + `check_approval_timeout` 内的 checkpoint 更新逻辑。

- `updateCheckpoint(state)`: 设置 `state.checkpoints.last_checkpoint_at = utcNowIso()` + 持久化
- `isCheckpointDue(state)`: 判断 `now - last_checkpoint_at > checkpoint_interval_seconds`
- 在 `approveRun` 和 `resumeRun` 中调用 `updateCheckpoint`（修复 Stage 2 deferral）

### 2. requestApproval 高级操作

Python SSOT: `orchestrator_state.py` → `cmd_request_approval`。

- `requestApproval(state, category, opts)`:
  - 生成 `approval_id` (via `nextApprovalId`)
  - 构造 `pending_approval` 对象（approval_id, category, plan_step_ids, requested_at, timeout_at, on_timeout, packet_path）
  - 转换状态 `running → awaiting_approval`
  - 写入 state + ledger
- 需要处理: timeout 计算（从 policy 读 timeout_seconds）、on_timeout 策略（block / reject）

### 3. Ledger detail parity 修复

在 approval 相关事件（approved/rejected/requested）的 ledger details 中，补齐 `category` 和 `note` 字段，
对齐 Python `append_ledger_event` 的 details 内容。

## 约束

- **Python 是 SSOT**: 实现前先 `Read` 对应 Python 函数体，逐字段对齐
- **双模型收敛**: 完成后用 Codex (xhigh, 不限时) + Gemini 审核
  - ❌ 绝不 TaskStop 截断审核模型（`dual-model-review-protocol` 记忆有详细说明）
  - ✅ 耐心等待，Codex xhigh 通常需要 10-20 分钟
- **测试**: 每个新方法至少 2 个测试（正常路径 + 错误/边界）
- **增量构建**: 先实现 → 本地 tsc + vitest 通过 → 再提交审核

## 验收标准

- [ ] tsc --noEmit clean
- [ ] vitest 全部通过（预期 ~46 tests: 36 existing + ~10 new）
- [ ] 双模型收敛（R1 或修正后 Rn）
- [ ] `meta/remediation_tracker_v1.json` NEW-05a note 更新
- [ ] Serena memory `architecture-decisions` 更新
- [ ] git commit

## 参考文件

| 文件 | 用途 |
|------|------|
| `packages/orchestrator/src/state-manager.ts` | 当前 Stage 2 代码（在此基础上扩展） |
| `packages/orchestrator/src/types.ts` | RunState / ApprovalPolicy 类型定义 |
| `packages/orchestrator/tests/orchestrator.test.ts` | 当前 36 tests |
| `packages/hep-autoresearch/src/hep_autoresearch/toolkit/orchestrator_state.py` | **Python SSOT** |
| `meta/docs/orchestrator-mcp-tools-spec.md` | 架构规格 |
| `meta/remediation_tracker_v1.json` | 进度追踪 |

## 不在范围

以下属于 Stage 3b（下一个对话）：
- Plan 验证与 plan.md markdown 渲染
- `.pause` / `.stop` sentinel 文件检测
- Run loop 集成（如果 TS 接管）
