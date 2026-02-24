# Prompt: Phase 1 Kickoff — NEW-01 + H-16a + H-11a 并行启动

> 本 prompt 用于新开 Claude Code 对话。
> 工作目录: `/home/user/Coding/Agents/autoresearch-lab/`（monorepo）
>
> **Serena 项目**: `autoresearch-lab`（已配置，onboarding 记忆已就绪）
> **启动前必读 Serena 记忆**: `architecture-decisions`, `dual-model-review-protocol`, `style-and-conventions`

---

## 上下文

Phase 0 全部 14 项完成 (2026-02-25)，Phase 1 解锁 (24 项)。

### Phase 0 完成状态

| 最后完成项 | 内容 | Commit |
|-----------|------|--------|
| NEW-05a | TS orchestrator state management parity (Stage 1-3c) | `d7d7c52` |
| review-swarm cleanup | 删除 run_dual_task, contract_fail informational-only | `d5246bb` |

- **145 tests** (orchestrator), **26 tests** (review-swarm), tsc clean
- Tracker: `meta/remediation_tracker_v1.json` — Phase 0 all done
- 双模型收敛审核协议已就绪 (`meta/review-swarm.json` + Serena memory)

### Phase 1 优先级 (从 architecture-decisions 记忆)

| Tier | 项目 | 理由 |
|------|------|------|
| **Tier 1** (关键路径) | **NEW-01** 跨语言类型代码生成 | Phase 1 gate — 消费生成类型的 PR 必须等 NEW-01 就绪 |
| **Tier 1** (可并行) | **H-16a** 工具名常量化 | 只依赖 C-03 (done)，低复杂度，quick win |
| **Tier 1** (可并行) | **H-11a** MCP 工具风险分级 | 只依赖 C-02 (done)，NEW-R15-spec 已有设计基础 |
| Tier 2 | M-01, M-14a, UX-01, NEW-R02, M-18 | Quick wins, 无 NEW-01 依赖 |

### Phase 1 内序门禁

> NEW-01 codegen 工具链必须先行就绪，方可合并消费生成类型的 PR

即: H-01, H-03, H-04, H-15a, H-18 等 `depends_on: ["NEW-01"]` 的项目在 NEW-01 完成前不能开始。

---

## 本对话任务

### Task 1: NEW-01 设计 (跨语言类型代码生成)

**目标**: 为 NEW-01 做技术设计并输出设计文档。

**范围**:
- 调研适合 monorepo 的 JSON Schema → TS/Python 代码生成方案
- 评估候选工具: `json-schema-to-typescript`, `quicktype`, `datamodel-code-generator`, 自建 transformer
- 设计 codegen pipeline: `meta/schemas/*.schema.json` → `packages/shared/src/generated/` + Python stubs
- 定义 CI gate: `make codegen-check` 验证生成代码与 schema 同步

**输出**: `meta/docs/design-new01-codegen.md`

**约束**:
- 不实现，只设计 — 实现留给下一个对话
- 考虑已有 18 个 registered schemas (tracker 中标注了 `schemas` 字段)
- 设计必须经双模型收敛审核

### Task 2: H-16a 实现 (工具名常量化)

**目标**: 将 hep-mcp 工具名从硬编码字符串提取为共享常量。

**范围**:
- 查找 `packages/hep-mcp/` 中所有工具名字符串
- 提取到 `packages/shared/src/tool-names.ts` (或类似路径)
- 更新所有消费端引用
- 包含 hep_run_* 写作工具命名明确化 (tracker note)

**验收标准**:
- [ ] `pnpm -r build` 成功
- [ ] 无硬编码工具名残留 (grep 验证)
- [ ] 现有测试全部通过

### Task 3: H-11a 设计 (MCP 工具风险分级)

**目标**: 基于 `meta/docs/orchestrator-mcp-tools-spec.md` 中的威胁模型，为 MCP 工具定义风险分级方案。

**范围**:
- 读取 NEW-R15-spec 中的威胁模型 (5 vectors)
- 定义风险级别 (read-only / state-mutating / destructive)
- 设计分级标注方式 (decorator / metadata / schema annotation)
- 输出设计文档

**输出**: `meta/docs/design-h11a-tool-risk-levels.md`

### Task 4: Tracker + Memory + Commit

- 更新 `meta/remediation_tracker_v1.json` 反映 Task 1-3 完成状态
- 写入 Serena 记忆 (`architecture-decisions`)
- Git commit

---

## 约束

- **双模型收敛**: NEW-01 设计文档必须经 Codex+Gemini 审核（使用 `run_multi_task.py`）
- **Python SSOT 原则**: 仍然适用，但 Phase 1 侧重抽象层而非逐函数 port
- **不越界**: Phase 2 项目不触碰。Stage 4 (CLI→MCP tools) 不在范围

## 参考文件

| 文件 | 用途 |
|------|------|
| `meta/remediation_tracker_v1.json` | 项目追踪器 |
| `meta/schemas/` | 已注册的 18 个 JSON Schemas |
| `meta/docs/orchestrator-mcp-tools-spec.md` | H-11a 设计基础 |
| `packages/shared/` | 共享类型包 (H-16a 目标位置) |
| `packages/hep-mcp/` | MCP 工具实现 (H-16a 源, H-11a 消费端) |
| `meta/review-swarm.json` | 双模型审核配置 |

## 不在范围

- NEW-01 的实现 (本对话只做设计)
- Phase 2 任何项目
- NEW-05a Stage 4 (CLI migration)
- 测试执行环境搭建
