# Prompt: NEW-05a Stage 3c 收敛 + Tracker 更新 + Scope 决策

> 本 prompt 用于新开 Claude Code 对话。
> 工作目录: `/home/user/Coding/Agents/autoresearch-lab/`（monorepo）
>
> **Serena 项目**: `autoresearch-lab`（已配置，onboarding 记忆已就绪）
> **启动前必读 Serena 记忆**: `architecture-decisions`, `dual-model-review-protocol`

---

## 上下文

NEW-05a TS orchestrator 迁移, Stage 1–3c 全部已实现:

| Stage | 内容 | 状态 | Tests |
|-------|------|------|-------|
| Stage 1 | 读操作 (readState, readPolicy, statusSummary) | R3 converged | — |
| Stage 2 | 写操作 (saveState, transitionStatus, createRun, approve/reject) | R3 converged | 51 |
| Stage 3a | checkpoint + requestApproval | R2 converged | +15 |
| Stage 3b | sentinel files + timeout/budget enforcement | R4 converged | +26 |
| Stage 3c | plan validation + plan.md derivation + sync helpers | **已实现, 待 R3 收敛** | +53 = **145 total** |

- **145 tests pass, tsc clean**
- Git: `fe4fb39` (Stage 3c implementation), `03b35f6` (HEAD, review-swarm 双格式 contract)
- Tracker stage 仍为 `stage_3b_complete`，需更新
- TS 源文件: `packages/orchestrator/src/state-manager.ts` (1351 LOC)
- Python SSOT: `packages/hep-autoresearch/src/hep_autoresearch/toolkit/orchestrator_state.py` (814 LOC)

### Stage 3c 双模型 review 历史

R1 found 4 blocking: B1-Codex (schema validation hand-coded not recursive), B2-Codex (plan_md_path hardcoded), B2-Gemini (Array.isArray guard)。全部修复。

R2 found 1 blocking: B1-Codex (`startsWith('..')` catches directory names like `..hidden`, should be `=== '..' || startsWith('../')`)。已修复。Gemini 两轮均 contract_fail (prose instead of JSON)。

review-swarm 双格式 contract 检测已修复 (commit `03b35f6`): contract checker 现在自动检测 Markdown / JSON 格式分别验证。

### Phase 0 总览

Phase 0 共 14 项: 13 项已 done, 仅 NEW-05a in_progress。NEW-05a 完成后 Phase 0 全部完成, 解锁 Phase 1 (24 项)。

### 遗留 deferrals (不阻塞收敛)

- B4-Stage2: state lock → 推迟到 H-07 (Phase 2)
- B5-Stage2: JSON compact separators Python/JS 差异 → cosmetic
- Gemini review-swarm contract compliance → 已修复 (双格式检测)

---

## 任务

### 1. Stage 3c 双模型 parity review (R3)

用 review-swarm 对 `packages/orchestrator/src/state-manager.ts` 的 Stage 3c 增量做 R3 review:

- 对比 Python SSOT: `packages/hep-autoresearch/src/hep_autoresearch/toolkit/orchestrator_state.py` L270-530
  - `validate_plan()` (L270-371): schema validation (递归 `_schema_validate`) + branching 跨字段不变量
  - `render_plan_md()` (L390-476): Markdown 渲染
  - `write_plan_md()` (L478-496): validate → render → 原子写
  - `save_state()` (L508-520): plan validation + plan_md_path + 原子写 + write_plan_md
- TS 对应方法: `validatePlan`, `renderPlanMd`, `writePlanMd`, `syncPlanCurrentStep`, `syncPlanTerminal` (L937-1351)
- 重点检查:
  - Schema validation 递归正确性 (`schemaValidate` vs `_schema_validate`)
  - `isDict()` guard (JS `typeof [] === 'object'`)
  - Branching 跨字段不变量 (active_branch 存在性, branch status 合法值)
  - `planMdRelativePath` 安全检查 (`=== '..' || startsWith('../')`)
  - `renderPlanMd` 输出与 Python 保真
  - `syncPlanCurrentStep`/`syncPlanTerminal` 与 Python `_sync_plan_current_step` 等价性

review-swarm 配置:
- `--check-review-contract` (现在支持 JSON 格式)
- `--fallback-mode auto --fallback-order codex,claude`
- Models: `claude/opus,gemini/default` 或 `codex/default,gemini/default`

如果 R3 CONVERGED → 继续。如果有 blocking → 修复后重新提交。

### 2. 更新 Tracker

更新 `meta/remediation_tracker_v1.json`:
- `NEW-05a.stage` → `"stage_3c_complete"`
- `NEW-05a.note` → 追加 Stage 3c 收敛信息 (R3 结果、test count、key fixes)

### 3. NEW-05a Scope 决策

评估并记录决策 (写入 Serena memory `architecture-decisions`):

- **选项 A (建议)**: 标记 NEW-05a 为 done (scope = state management parity)，CLI 命令层迁移推迟到 NEW-R15-impl (Phase 2)
  - 理由:
    1. 验收标准 "TS 编排器可管理 state.json + ledger.jsonl 与 Python 版格式兼容" 已满足
    2. CLI 命令层 6070 LOC 中大量是 UI/formatting 代码，TS 版消费方式为 MCP 工具而非 CLI
    3. NEW-R15-impl 已在 Phase 2 规划了编排器 MCP 工具实现 (orch_run_* + orch_policy_query)
    4. Phase 0 完成后可解锁 Phase 1 的 24 项
- **选项 B**: 继续 Stage 4 (CLI 命令层 → TS MCP 工具)，在 Phase 0 内完成

### 4. (如果选 A) Phase 0 完成确认 + Phase 1 优先级

- 确认 Phase 0 所有 14 项 done
- 更新 tracker: `NEW-05a.status` → `"done"`, `completed_at` → 当前日期
- 列出 Phase 1 建议优先启动项 (考虑依赖关系和 unblock 效果)
- 写入 Serena memory: Phase 1 启动优先级决策

---

## 参考文件

| 文件 | 用途 |
|------|------|
| `packages/orchestrator/src/state-manager.ts` | TS 实现 (review 对象) |
| `packages/orchestrator/tests/orchestrator.test.ts` | 145 tests |
| `packages/hep-autoresearch/src/hep_autoresearch/toolkit/orchestrator_state.py` | Python SSOT |
| `packages/hep-autoresearch/specs/plan.schema.json` | Plan JSON Schema |
| `meta/remediation_tracker_v1.json` | Tracker (需更新) |
| `meta/docs/prompt-new05a-stage3c.md` | Stage 3c 原始 prompt |
