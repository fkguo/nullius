# Prompt: Phase 1 Implementation Batch 2 — 核心抽象层 (H-15a + H-18 + H-03 + H-04 + H-11a 执行)

> 本 prompt 用于新开 Claude Code 对话。
> 工作目录: `/home/user/Coding/Agents/autoresearch-lab/`（monorepo）
>
> **Serena 项目**: `autoresearch-lab`（已配置，onboarding 记忆已就绪）
> **启动前必读 Serena 记忆**: `architecture-decisions`, `style-and-conventions`

---

## 上下文

Phase 1 Batch 1 完成 (2026-02-25)，以下已实现并提交至 main:

| 项目 | 状态 | Commit | 关键产物 |
|------|------|--------|----------|
| H-16a (tool names) | **done** | `617d798` | 83 constants in `packages/shared/src/tool-names.ts` |
| NEW-01 (codegen) | **Phase 1B done** | `cac9047` | 18 TS + 18 Python types, `make codegen` / `make codegen-check` |
| H-11a (tool risk) | **Phase 1 done** | `cac9047` | `ToolRiskLevel`, `TOOL_RISK_LEVELS`, riskLevel on ToolSpec, 3 contract tests |

### 当前关键路径

```
NEW-01 done ✅ → 以下 consumer 项现可执行:
  ├─ H-15a EcosystemID 规范
  │  └─ H-18 ArtifactRef V1 (depends: H-15a)
  ├─ H-03 RunState v1 统一枚举
  ├─ H-04 Gate Registry + 静态校验
  │  └─ M-22 GateSpec 通用抽象 (depends: H-04, 可延后)
  └─ H-01 AutoresearchError 信封 (depends: H-14a Phase 0)
     ├─ H-02 最小可观测性 (depends: H-01, 可延后)
     └─ H-19 失败分类 (depends: H-01, 可延后)

H-11a Phase 1 done ✅ → Phase 2 (dispatcher 执行) 可并行
```

### 不在范围

- Phase 2 深度集成项 (H-05, H-07, H-09, H-10, H-11b, H-12)
- 深度重构项 (NEW-R02, NEW-R03b, NEW-R04, NEW-R09)
- UX 项 (UX-01, UX-05, UX-06)
- M-18 配置管理统一 (depends H-20)
- M-19 跨组件 CI 集成测试 (depends H-17)

---

## 任务清单

### Task 1: H-15a — EcosystemID 规范

**目标**: 定义跨组件标识符统一格式，为 H-18 ArtifactRef 奠基。

**输入**:
- `meta/REDESIGN_PLAN.md` §H-15a 段落
- 现有 ID 模式: run_id, project_id, artifact names（grep `assertSafePathSegment` 和 `SafePathSegmentSchema`）

**产出**:
1. `packages/shared/src/ecosystem-id.ts` — EcosystemID 类型 + 验证函数 + 前缀规范
2. 前缀注册表 (e.g., `run_`, `proj_`, `art_`, `evt_`, `sig_`)
3. 单元测试: `packages/shared/tests/ecosystem-id.test.ts`
4. 更新 `packages/shared/src/index.ts` 导出

**约束**:
- ID 格式必须是 URL-safe, filesystem-safe
- 必须兼容现有 `SafePathSegmentSchema` 约束（无 `/`, `\`, `..`）
- 前缀必须是 snake_case + `_` 分隔
- 与 `meta/schemas/` 中的 `$id` URI pattern 正交（EcosystemID 是运行时标识，schema $id 是设计时元数据）

### Task 2: H-18 — ArtifactRef V1

**目标**: 统一 artifact 引用格式，替代散落的 `{ uri, name, run_id }` ad-hoc 结构。

**输入**:
- `meta/schemas/artifact_ref_v1.schema.json`（已有 JSON Schema + 已生成 TS/Python 类型）
- `packages/shared/src/generated/artifact-ref-v1.ts`（已生成）
- 现有 `writeRunJsonArtifact` 返回值模式（grep `ArtifactRef` 或 `artifact_ref`）
- 设计原则: Evidence-first I/O（大对象写 artifacts，tool result 返回 URI + 摘要）

**产出**:
1. `packages/shared/src/artifact-ref.ts` — ArtifactRef 运行时构造/验证工具（基于已生成的类型）
2. 将 `writeRunJsonArtifact` 返回类型对齐到 ArtifactRef V1
3. 更新使用方 (hep-mcp vnext) 的类型引用
4. 确保 contract test 覆盖

**约束**:
- ArtifactRef 必须包含 `uri` (hep:// 格式), `name`, `run_id`, `content_hash` (optional)
- 生成类型 (`packages/shared/src/generated/artifact-ref-v1.ts`) 是 SSOT；手写代码只做构造 + 验证辅助
- 不引入新的 `hep://` URI 格式，复用现有格式

### Task 3: H-03 — RunState V1 统一枚举

**目标**: 统一 run 生命周期状态枚举，替代现有散落的字符串字面量。

**输入**:
- `meta/REDESIGN_PLAN.md` §H-03
- 现有 run 状态: grep `status` in `packages/hep-mcp/src/vnext/runs.ts`

**产出**:
1. `packages/shared/src/run-state.ts` — RunState 枚举 (e.g., `created | running | paused | done | failed`)
2. 更新 `packages/hep-mcp/src/vnext/runs.ts` 使用 RunState 枚举
3. 更新相关 Zod schemas 使用枚举
4. 测试

**约束**:
- 与 SkillBridgeJobEnvelope 中的 `terminal_statuses: ['done', 'failed']` 一致
- 状态值必须是 snake_case 字符串（与现有约定一致）

### Task 4: H-04 — Gate Registry + 静态校验

**目标**: 定义 Gate 抽象（approval checkpoint），为自动化流程中的人类审批节点建立统一注册表。

**输入**:
- `meta/REDESIGN_PLAN.md` §H-04
- 现有 approval 模式: `packages/hep-autoresearch/` 中的 approval gate（如有）

**产出**:
1. `packages/shared/src/gate-registry.ts` — GateSpec 类型 + GateRegistry
2. Gate 类型: `approval` (人类审批), `quality` (自动质量检查), `budget` (token/cost 预算)
3. 静态校验: 编译时检查 gate 名称唯一性
4. 测试

**约束**:
- Gate 名称使用 snake_case，与 tool name 约定一致
- GateSpec 包含: `name`, `type`, `description`, `required_risk_level` (关联 H-11a)
- 不实现执行逻辑（Phase 2 H-11b），只定义 schema 和注册表

### Task 5: H-11a Phase 2 — Dispatcher 执行强化

**目标**: 在 hep-mcp dispatcher 中对 `destructive` 工具执行 `_confirm` 参数检查。

**输入**:
- `packages/hep-mcp/src/tools/dispatcher.ts` — 现有 dispatch 逻辑
- `packages/shared/src/tool-risk.ts` — TOOL_RISK_LEVELS (已有)
- `meta/docs/design-h11a-tool-risk-levels.md` §5 执行机制

**产出**:
1. 修改 `handleToolCall()`: 在 `parseToolArgs()` 之前检查 riskLevel
2. 若 tool 是 `destructive` 且 `args._confirm !== true`，返回结构化 error:
   ```json
   {
     "error": {
       "code": "CONFIRMATION_REQUIRED",
       "message": "Tool <name> is destructive. Pass _confirm: true to proceed.",
       "data": {
         "tool": "<name>",
         "risk_level": "destructive",
         "next_actions": [{ "tool": "<name>", "args": { "...", "_confirm": true } }]
       }
     }
   }
   ```
3. 添加 `_confirm` 到这 5 个 destructive 工具的 Zod schema（optional boolean）
4. Contract test: destructive 工具无 _confirm → error; 有 _confirm → 通过

**约束**:
- `_confirm` 参数不影响 `read` 和 `write` 工具
- 不对 `write` 工具添加确认（那是 Phase 2 H-11b 的范围）
- Error code 使用 `CONFIRMATION_REQUIRED`（新增，不是 `INVALID_PARAMS`）

---

## 执行顺序

```
Phase A — 实现 (Tasks 1-5)
  Task 1 (H-15a) → Task 2 (H-18)    ← 串行依赖
  Task 3 (H-03)                      ← 独立，可与 Task 1 并行
  Task 4 (H-04)                      ← 独立，可与 Task 1 并行
  Task 5 (H-11a Phase 2)             ← 独立，可与上述并行

Phase B — 双模型收敛检查 (见下文 §双模型收敛检查)

Phase C — 修正 + 提交
```

建议: Task 1 先做（因为 Task 2 依赖它），Task 3/4/5 可并行或按顺序。

---

## 双模型收敛检查

### 触发依据

以下 4 个 task 属于 **跨组件架构变更**（新类型定义在 `packages/shared/`，被 ≥2 个组件消费），按 CLAUDE.md 规定**必须**执行多模型收敛检查：

| Task | 触发条件 |
|------|---------|
| H-15a EcosystemID | 新跨组件类型，定义 ID 格式契约 |
| H-18 ArtifactRef V1 | 跨组件 artifact 引用契约 |
| H-03 RunState V1 | 跨组件枚举，替代多处字面量 |
| H-04 Gate Registry | 新跨组件抽象，关联 H-11a |

Task 5 (H-11a Phase 2) 是 **单组件** dispatcher 内部变更，**不需要**双模型检查。

### 评审 packet 结构

所有实现完成、`pnpm -r build && pnpm -r test` 通过后，生成**一个合并的评审 packet**:

```markdown
# Review Packet: Phase 1 Batch 2 — 核心抽象层

## 评审范围
跨组件类型定义：H-15a, H-18, H-03, H-04

## 评审标准
1. 类型定义是否足够表达其领域语义？
2. 命名约定是否与现有 codebase 一致（snake_case ID, 前缀注册表等）？
3. 跨组件边界契约是否清晰？消费方能否无歧义使用？
4. 映射表（H-03 legacy → canonical）是否完整、可逆？
5. 有无过度设计（不需要的抽象/配置）？

## 待评审文件
- `packages/shared/src/ecosystem-id.ts` (H-15a)
- `packages/shared/src/artifact-ref.ts` (H-18)
- `packages/shared/src/run-state.ts` (H-03)
- `packages/shared/src/gate-registry.ts` (H-04)
- 对应测试文件

## 原始设计参考
- `meta/REDESIGN_PLAN.md` §H-15a, §H-03, §H-04
- `meta/schemas/artifact_ref_v1.schema.json`
- `meta/docs/design-h11a-tool-risk-levels.md`
```

### 执行方式

使用 `review-swarm` skill（双模型快速路径）：

```bash
# 1. 将评审 packet 写入文件
#    → meta/reviews/batch2-review-packet.md

# 2. 执行 review-swarm
python3 skills/review-swarm/scripts/bin/run_multi_task.py \
  --out-dir meta/reviews/batch2-R1 \
  --system meta/reviews/batch2-system.md \
  --prompt meta/reviews/batch2-review-packet.md
```

配置从 `meta/review-swarm.json` 自动加载（models: `codex/gpt-5.3-codex`, `gemini/gemini-3.1-pro-preview`）。

### 收敛判定

- **CONVERGED**: 所有模型 0 blocking issues → 通过
- **NOT_CONVERGED**: 任一模型有 blocking issue → 修正后重新提交 (R+1)
- **最大轮次**: 5 轮。超过 5 轮未收敛 → 人类介入

---

## Context 管理策略

> Batch 1（4 tasks）在单个对话中耗尽了 context。Batch 2 有 5 tasks + 评审，务必节约。

1. **不要完整读取大文件**（如 `registry.ts` 1000+ 行）— 用 grep 定位 + offset/limit 读取
2. **不要重复探索已知结构** — 上方"输入"字段已标注关键文件路径
3. **Task 间不重复** — 每个 Task 完成后立即 `pnpm -r build` 验证，不在最后集中排错
4. **评审 packet 精简** — 只包含类型定义和接口签名，不贴完整实现

---

## 完成后

1. `pnpm -r build` 全部通过
2. `pnpm -r test` 全部通过（0 failures）
3. `make smoke` 通过
4. 双模型收敛检查 CONVERGED
5. 更新 Serena memory: `architecture-decisions`
6. Git commit + push
7. 输出下一批次 prompt（如仍有 Phase 1 剩余项）
