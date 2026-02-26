# Phase 1 Batch 3 — 运行时基础层

## 前置状态

- Phase 0: ALL DONE
- Phase 1 Batch 1: NEW-01 ✅, H-11a ✅, H-16a ✅
- Phase 1 Batch 2: H-15a ✅, H-18 ✅, H-03 ✅, H-04 ✅, H-11a P2 ✅
- REDESIGN_PLAN: v1.8.0-draft (commit 91d4686)

## 本批目标

关键路径: **H-01 → H-02 + H-19 → NEW-CONN-01**

### 1. H-01: McpError 扩展 (~20 LOC)

在 `packages/shared/src/errors.ts` 的 `McpError` 中添加:
- `retryable: boolean`
- `retryAfterMs?: number`

错误码默认映射:
- `RATE_LIMIT` → `retryable: true`
- `UPSTREAM_ERROR` → `retryable: true`
- `INVALID_PARAMS` → `retryable: false`
- 其余按语义分类

参考 `meta/REDESIGN_PLAN.md` H-01 节。

**不做**: 不创建 `AutoresearchErrorEnvelope`、不新建 `errors/` 子目录、不在 Python 侧创建 adapter。

### 2. H-02: 最小可观测性 trace_id

参考 `meta/REDESIGN_PLAN.md` H-02 节。

- `packages/shared/src/tracing.ts`: `generateTraceId()` (UUID v4) + `extractTraceId(params)`
- `hep-research-mcp/src/tools/dispatcher.ts`: 每次 tool call 注入 `trace_id`；错误响应包含 `trace_id`
- Python 侧 (`mcp_stdio_client.py`, `orchestrator_state.py`): 注入 + 记录 trace_id

### 3. H-19: 重试/退避策略 (TS 主实现 + Python 临时 stopgap)

参考 `meta/REDESIGN_PLAN.md` H-19 节 (v1.8.0 re-scoped)。

**TS 主实现** (NEW-RT-01/02 的直接依赖):
- `packages/shared/src/retry-policy.ts`: `RetryPolicy` 类型定义
- `packages/orchestrator/src/retry.ts`: `retryWithBackoff(fn, policy)` 工具函数

**Python 临时 stopgap**:
- `hep-autoresearch/.../retry.py`: 简化重试装饰器
- `hep-autoresearch/.../mcp_stdio_client.py`: 集成基本 RetryPolicy

**退役规则**: TS 实现就绪并通过验收后，Python 侧重试逻辑**立即删除**，不设缓冲期。

### 4. NEW-CONN-01: Discovery next_actions hints (~100 LOC)

参考 `meta/REDESIGN_PLAN.md` NEW-CONN-01 节。依赖 H-16a (done)。

在文献发现工具 (`inspire_search`, `inspire_literature`, `inspire_research_navigator`) 的返回中补充 `next_actions` hint，引导用户调用下一步工具 (如 `inspire_deep_research`, `hep_project_build_evidence`)。

使用 `packages/shared/src/tool-names.ts` 中的常量引用工具名。

## 执行约束

1. 先读 Serena 记忆 `architecture-decisions` 获取上下文
2. 按依赖顺序实现: H-01 → H-02 → H-19 → NEW-CONN-01
3. 每项完成后跑对应单元测试
4. 全部完成后执行双模型收敛检查:
   - **Codex**: `gpt-5.3-codex` xhigh（代码实现审核）
   - **Gemini**: `gemini-3.1-pro-preview`
   - 使用 `review-swarm` skill（`meta/review-swarm.json` 已配置 `gpt-5.3-codex`）
5. 收敛后提交 (单次 commit 包含全部 4 项)
