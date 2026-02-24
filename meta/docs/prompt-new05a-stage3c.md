# Prompt: NEW-05a Stage 3c — Plan Validation + plan.md Derivation

> 本 prompt 用于新开 Claude Code 对话。
> 工作目录: `/home/user/Coding/Agents/autoresearch-lab/`（monorepo）
>
> **Serena 项目**: `autoresearch-lab`（已配置，onboarding 记忆已就绪）
> **启动前必读 Serena 记忆**: `architecture-decisions`, `dual-model-review-protocol`

---

## 上下文

NEW-05a TS orchestrator 迁移，Stage 1（读操作）+ Stage 2（写操作）+ Stage 3a（checkpoint + requestApproval）+ Stage 3b（sentinel + timeout + budget + checkpoint command + ledger parity）已完成。

- **92 tests pass**（51 Stage 1-2 + 15 Stage 3a + 26 Stage 3b）
- **Stage 3b R4 双模型 CONVERGED**（Codex gpt-5.3-codex xhigh + Gemini）
- Git commit: `53c2fd1`（Stage 3b 实现），`233fe22`（HEAD，review-swarm 文档更新）
- Tracker stage: `stage_3b_complete`

### Stage 3b saveState 中的显式 TODO

当前 `saveState()` 有注释：

```typescript
/** Atomic write of state.json. Matches Python save_state().
 *  Does NOT handle plan validation/plan.md derivation (Python remains plan SSOT). */
saveState(state: RunState): void {
  writeJsonAtomic(this.statePath, state as unknown as Record<string, unknown>);
}
```

Python `save_state()` 的完整逻辑是：
1. 如果 `state.plan` 存在 → `validate_plan(repo_root, plan=plan)`（含 branching 跨字段不变量）
2. 设置 `state.plan_md_path`
3. 原子写 `state.json`
4. 调用 `write_plan_md(repo_root, plan=plan)`（validate → render → 原子写 `.autoresearch/plan.md`）

### checkpoint 中的显式 TODO

当前 `checkpoint()` 有注释：

```typescript
/** Note: _sync_plan_current_step is not ported (→ Stage 3c: plan validation). */
```

## Stage 3c 范围

在 `packages/orchestrator/src/state-manager.ts` 中扩展，实现 plan 验证和 plan.md 派生。

### 1. validate_plan — Plan 验证（含 branching 跨字段不变量）

Python SSOT: `orchestrator_state.py` → `validate_plan()` (L270-371)。

这是一个**纯验证函数**，不修改 plan，只在不一致时 throw。需要实现的检查：

#### 1a. JSON Schema 基础验证

验证 plan 结构符合 `specs/plan.schema.json` 的关键约束（不需要完整 JSON Schema 引擎，手动检查关键字段即可，匹配 Python `_schema_validate` 的实际覆盖范围）：

- `schema_version`: integer ≥ 1
- `created_at`, `updated_at`: non-empty string
- `steps`: array of objects
- 每个 step: `step_id` (non-empty string), `description` (non-empty string), `status` (enum: pending/in_progress/completed/blocked/failed/skipped), `expected_approvals` (array), `expected_outputs` (array), `recovery_notes` (string)

#### 1b. Branching 跨字段不变量（关键）

这是 validate_plan 最复杂的部分。逐项对齐 Python L281-371：

1. **step_id 唯一性**: 收集所有 step.step_id 到 set
2. **decision_id 唯一性**: decisions 数组中不能有重复 decision_id
3. **decision.step_id 引用完整性**: 每个 decision 的 step_id 必须在 plan.steps 中存在
4. **branch_id 唯一性**: 同一 decision 内不能有重复 branch_id
5. **decision.active_branch_id 指向性**:
   - 如果 set，必须指向 branches 中的某个 branch
   - 该 branch 的 status 必须是 `'active'`
6. **单 active branch 约束**: 每个 decision 内最多一个 status='active' 的 branch
7. **active branch 与 decision.active_branch_id 一致性**: 如果有 active branch，decision.active_branch_id 必须等于该 branch_id
8. **全局 branching.active_branch_id**:
   - 格式必须是 `<decision_id>:<branch_id>`
   - 必须有至少一个 active pair
   - composite id 必须匹配某个 active pair

#### 1c. 函数签名

```typescript
validatePlan(plan: Record<string, unknown>): void  // throws on invalid
```

不需要 `repo_root` 参数（Python 版用 repo_root 读 schema 文件，TS 版直接硬编码验证逻辑）。

### 2. render_plan_md — Markdown 渲染

Python SSOT: `orchestrator_state.py` → `render_plan_md()` (L390-475)。

纯函数：`plan → string`。逐行对齐 Python 输出格式：

```markdown
# Plan (derived view)

- Run: {run_id}
- Workflow: {workflow_id}
- Updated: {updated_at}

SSOT: `.autoresearch/state.json#/plan`

## Steps

1. [{status}] {step_id} — {description}
   - expected_approvals: A1, A3
   - expected_outputs:
     - path/to/output1
   - recovery_notes: ...

## Branching

- active_branch_id: decision1:branch_a
- max_branches_per_decision: 5

### Decisions

1. decision1 — Title
   - step_id: step_1
   - max_branches: 3
   - active_branch_id: branch_a
   - branches:
     - [active] branch_a — Label: Description text
```

#### 函数签名

```typescript
renderPlanMd(plan: Record<string, unknown>): string
```

### 3. write_plan_md — 原子写

Python SSOT: `orchestrator_state.py` → `write_plan_md()` (L478-495)。

```typescript
writePlanMd(plan: Record<string, unknown>): string  // returns relative path
```

逻辑：
1. `validatePlan(plan)` — 写之前必须验证
2. `ensureDirs()`
3. 渲染 `renderPlanMd(plan)` → content string
4. 原子写到 `.autoresearch/plan.md`（`.tmp` → rename）
5. 返回相对路径（匹配 Python 返回值）

### 4. 集成到 saveState / saveStateWithLedger

#### saveState 修改

```typescript
saveState(state: RunState): void {
  const plan = state.plan;
  if (plan && typeof plan === 'object') {
    this.validatePlan(plan);
    state.plan_md_path = /* relative path to plan.md */;
  }
  writeJsonAtomic(this.statePath, state);
  if (plan && typeof plan === 'object') {
    // SSOT-first: state.json already persisted, now derive plan.md
    this.writePlanMd(plan);
  }
}
```

#### saveStateWithLedger 修改

在 step 1（stage state）之前增加 plan 验证和 plan_md_path 设置：

```typescript
saveStateWithLedger(state, eventType, opts): void {
  // 0. Plan validation + plan_md_path (new)
  const plan = state.plan;
  if (plan && typeof plan === 'object') {
    this.validatePlan(plan);
    state.plan_md_path = /* relative path */;
  }
  // 1. Stage state to .next
  // 2. Append ledger
  // 3. Commit: rename staged → final
  // 4. Derive plan.md (new — after state is safely persisted)
  if (plan && typeof plan === 'object') {
    this.writePlanMd(plan);
  }
}
```

### 5. _sync_plan_current_step 集成

Python SSOT: `orchestrator_cli.py` → `_sync_plan_current_step()` (L1955-1999)。

在 `checkpoint()` 方法中集成 plan step 同步：

```typescript
checkpoint(state, opts?): { action?: string } {
  // ... existing timeout/budget checks ...

  // Plan step sync (matching Python _sync_plan_current_step)
  if (opts?.step_id && state.plan && typeof state.plan === 'object') {
    this.syncPlanCurrentStep(state, opts.step_id, opts.step_title ?? '');
  }

  // ... rest of checkpoint ...
}
```

`syncPlanCurrentStep(state, stepId, title)` 逻辑（匹配 Python L1955-1999）：
1. `plan.updated_at = utcNowIso()`
2. `plan.current_step_id = stepId`
3. 遍历 steps：找到匹配的 step → 设置 `status: 'in_progress'`, `started_at`（如果尚未设置）, `completed_at: null`
4. 其他 `in_progress` 的 step → 自动转 `completed`
5. 如果 stepId 不存在于 steps → append 新 step

### 6. _sync_plan_terminal 方法

Python SSOT: `orchestrator_cli.py` → `_sync_plan_terminal()` (L2002-2039)。

```typescript
syncPlanTerminal(state: RunState, stepId: string, title: string, status: string): void
```

逻辑：
1. `plan.updated_at = utcNowIso()`
2. 遍历 steps：找到 stepId → 设置 `status`，如果是 completed/failed 设置 `completed_at`
3. 如果不存在 → append

## 约束

- **Python 是 SSOT**: 实现前先 `Read` 对应 Python 函数体，逐字段对齐
- **双模型收敛**: 完成后用 `review-swarm` skill（项目配置 `meta/review-swarm.json` 已就绪）
  - 模型: `codex/gpt-5.3-codex,gemini/gemini-3.1-pro-preview`
  - ❌ 绝不 TaskStop 截断审核模型（`dual-model-review-protocol` 记忆有详细说明）
  - ✅ 所有审核模型有只读工具访问权限（Codex: sandbox read-only, Claude: Read/Glob/Grep/Bash, Gemini: approval-mode plan）
  - ✅ 耐心等待，Codex xhigh 通常需要 10-20 分钟
- **测试**: 每个新方法至少 2 个测试（正常路径 + 错误/边界）
- **增量构建**: 先实现 → 本地 tsc + vitest 通过 → 再提交审核

## 实施顺序建议

1. 读取 Python SSOT（validate_plan, render_plan_md, write_plan_md, _sync_plan_current_step, _sync_plan_terminal）
2. 实施 §1 validatePlan（含完整 branching 不变量检查）
3. 实施 §2 renderPlanMd
4. 实施 §3 writePlanMd
5. 实施 §4 修改 saveState + saveStateWithLedger（plan 验证 + plan.md 派生）
6. 实施 §5 syncPlanCurrentStep + 集成到 checkpoint
7. 实施 §6 syncPlanTerminal
8. 写测试（预期 ~25-35 new tests，涵盖：validatePlan 正常/各类不变量违规、renderPlanMd 无分支/有分支、writePlanMd 原子写、saveState 含 plan、syncPlanCurrentStep 各路径、syncPlanTerminal）
9. tsc + vitest 全部通过（预期 ~115-130 tests: 92 existing + 25-35 new）
10. 双模型收敛审核
11. 更新 tracker + Serena memory + git commit

## 验收标准

- [ ] tsc --noEmit clean
- [ ] vitest 全部通过（预期 ~115-130 tests）
- [ ] validatePlan 覆盖所有 Python L281-371 的跨字段不变量
- [ ] renderPlanMd 输出格式与 Python 逐行一致
- [ ] saveState 和 saveStateWithLedger 在 plan 存在时自动验证 + 派生 plan.md
- [ ] checkpoint 集成 _sync_plan_current_step
- [ ] 双模型收敛（R1 或修正后 Rn）
- [ ] `meta/remediation_tracker_v1.json` NEW-05a note 更新
- [ ] Serena memory `architecture-decisions` 更新
- [ ] git commit

## 参考文件

| 文件 | 用途 |
|------|------|
| `packages/orchestrator/src/state-manager.ts` | 当前 Stage 3b 代码（在此基础上扩展） |
| `packages/orchestrator/src/types.ts` | RunState 类型定义（plan 已是 `Record<string, unknown> \| null`，无需修改） |
| `packages/orchestrator/tests/orchestrator.test.ts` | 当前 92 tests |
| `packages/hep-autoresearch/src/hep_autoresearch/toolkit/orchestrator_state.py` | **Python SSOT** — validate_plan (L270-371), render_plan_md (L390-475), write_plan_md (L478-495), save_state (L508-519), _persist_state_with_ledger_event_locked (L557-605) |
| `packages/hep-autoresearch/src/hep_autoresearch/orchestrator_cli.py` | **Python SSOT** — _require_plan (L818-822), _ensure_plan_branching (L858-893), _plan_step (L1692-1717), _sync_plan_current_step (L1955-1999), _sync_plan_terminal (L2002-2039) |
| `packages/hep-autoresearch/specs/plan.schema.json` | Plan JSON Schema（6 种 step status, branching 结构） |
| `meta/review-swarm.json` | 双模型审核的项目配置（模型 + fallback） |
| `meta/remediation_tracker_v1.json` | 进度追踪 |

## 不在范围

以下属于后续阶段：
- `_build_plan_for_run`（workflow-specific plan 构建 → 需要 workflow context 层，属于 run loop 集成）
- `_ensure_plan_branching`（branching 初始化/修复辅助函数 → 按需实现，不是 Stage 3c 的必选项；如果 validate_plan 测试需要可以顺便加）
- MCP 工具层集成（`orch_run_*` tool registration → NEW-R15-impl）
- Run loop / workflow execution 逻辑
- State locking（→ H-07）
