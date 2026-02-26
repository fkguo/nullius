# Prompt: Phase 1 Implementation Batch 1 — NEW-01 1A Spike + H-11a 实现 + Tier 2 Quick Wins

> 本 prompt 用于新开 Claude Code 对话。
> 工作目录: `/home/user/Coding/Agents/autoresearch-lab/`（monorepo）
>
> **Serena 项目**: `autoresearch-lab`（已配置，onboarding 记忆已就绪）
> **启动前必读 Serena 记忆**: `architecture-decisions`, `style-and-conventions`

---

## 上下文

Phase 1 kickoff 完成 (2026-02-25)，以下设计已通过双模型收敛审核:

| 项目 | 状态 | Commit | 设计文档 |
|------|------|--------|----------|
| NEW-01 (codegen) | design_complete (R3 CONVERGED) | `1a3b65a` | `meta/docs/design-new01-codegen.md` |
| H-11a (tool risk) | design_complete | `617d798` | `meta/docs/design-h11a-tool-risk-levels.md` |
| H-16a (tool names) | **done** | `617d798` | — |

### 当前关键路径

```
NEW-01 Phase 1A spike → NEW-01 Phase 1B rollout → H-01, H-03, H-04, H-15a, H-18 (消费生成类型)
                                                    ↑ Phase 1 gate
H-11a 实现 (无依赖，可并行)
Tier 2 quick wins (无依赖，可并行)
```

---

## 本对话任务

### Task 1: NEW-01 Phase 1A — 工具链 Spike (Gate)

**目标**: 验证 `json-schema-to-typescript` 和 `datamodel-code-generator` 在条件 schema 上的输出质量。

**设计文档**: `meta/docs/design-new01-codegen.md` §4.6

**步骤**:
1. 安装工具 (pinned versions):
   - `pnpm add -D json-schema-to-typescript` (in `packages/shared/`)
   - `pip install datamodel-code-generator` (或 `uv pip install`)
2. 在 3 个目标 schema 上运行两个生成器:
   - `research_event_v1.schema.json` (最复杂: 15 payload types via `if-then-allOf`)
   - `research_signal_v1.schema.json`
   - `strategy_state_v1.schema.json` (替代 `memory_graph_node_v1`, 因为 `strategy_state_v1` 标注为 High complexity)
3. 检查 TS 输出: `if-then-allOf` 是否生成有用的 discriminated union types, 还是退化为 `any`/intersection?
4. 检查 Python 输出: 是否生成 Pydantic `Discriminator`, 还是 fallback 到 `Union[...]`?
5. 根据结果做决策:
   - 如果两个工具输出可接受 → 记录 spike 结论, 进入 Task 2 (Phase 1B)
   - 如果 TS 输出退化 → 编写 `ts-morph` 自动后处理器 (设计文档 §4.6 Decision criteria)
   - 如果 Python 输出退化 → 评估是否需要重构 schema 为 `oneOf` + `const`
   - 如果两者都严重失败 → 记录失败, 标记 Phase 1A 为 blocked, 不执行 Task 2

**R3 非阻塞建议** (尽量在 spike 中一并验证):
- 检查是否有 `$ref` 使用绝对 URI (需要 resolver)
- 验证 `--disable-timestamp` 是否产生确定性输出
- 比较 per-file vs bundled generation 的 `$defs` 处理

**验收标准**:
- [ ] 3 个 schema 的 TS + Python 输出存在且可编译/解析
- [ ] Spike 结论文档化 (可附在设计文档末尾或 Serena memory)
- [ ] Gate 判定: proceed / need-post-processor / need-schema-refactor / blocked

### Task 2: NEW-01 Phase 1B — Full Rollout (仅在 Task 1 通过时执行)

**目标**: 实现完整 codegen pipeline, 覆盖全部 18 schemas。

**设计文档**: `meta/docs/design-new01-codegen.md` §4-5, §7 Phase 1B

**实现范围**:
1. `meta/scripts/codegen-resolve-refs.ts` — 共享 `$ref` 预解析 (§4.5 Step 0)
2. `meta/scripts/codegen-ts.ts` — TS 生成包装 (§4.2)
3. `meta/scripts/codegen-barrel.ts` — TS barrel export 生成
4. `meta/scripts/codegen-py-init.ts` — Python `__init__.py` 生成
5. `meta/scripts/codegen.sh` — 编排脚本 (§4.5)
6. `packages/shared/src/generated/` — 生成的 TS 类型
7. `meta/generated/python/` — 生成的 Python 类型 (含 `__init__.py`)
8. Makefile targets: `codegen`, `codegen-check` (§5.1)
9. 双向一致性测试: `Exact<z.infer<typeof ZodSchema>, GeneratedType>` (§4.4)

**验收标准**:
- [ ] `make codegen` 成功生成 18 TS + 18 Python 文件
- [ ] `make codegen-check` 通过 (git diff clean + no untracked files)
- [ ] `tsc --noEmit` 编译成功 (含生成的类型)
- [ ] `python3 -m py_compile` 解析成功
- [ ] 至少对有 Zod 等价物的 schema 建立一致性测试
- [ ] `pnpm -r build && pnpm -r test` 通过

### Task 3: H-11a 实现 (MCP 工具风险分级)

**目标**: 基于设计文档实现风险分级方案。

**设计文档**: `meta/docs/design-h11a-tool-risk-levels.md` §5-7

**实现范围**:
1. `packages/shared/src/tool-risk.ts`:
   - `ToolRiskLevel` type (`'read' | 'write' | 'destructive'`)
   - `TOOL_RISK_LEVELS` static map (83 tools, 使用 H-16a 常量)
2. `packages/shared/src/index.ts`: export tool-risk
3. 各 registry 文件添加 `riskLevel` 字段:
   - `packages/hep-mcp/src/tools/registry.ts` (67 tools)
   - `packages/pdg-mcp/src/tools/registry.ts` (9 tools)
   - `packages/zotero-mcp/src/tools/registry.ts` (7 tools)
4. `packages/hep-mcp/src/tools/dispatcher.ts`: `_confirm` enforcement for destructive tools
5. Contract tests: 验证所有 tool 的 riskLevel 与 `TOOL_RISK_LEVELS` 一致
6. 更新 C-03 tool catalog generator: 输出中包含 `risk_level`

**验收标准**:
- [ ] 所有 83 tools 有 `riskLevel` 字段
- [ ] 5 个 destructive tools 未传 `_confirm: true` 时返回确认提示
- [ ] `TOOL_RISK_LEVELS` map 与 registry 一致 (contract test)
- [ ] `pnpm -r build && pnpm -r test` 通过

### Task 4: Tracker + Memory + Commit

- 更新 `meta/remediation_tracker_v1.json`
- 写入 Serena 记忆
- Git commit (逻辑单元分 commit: spike / codegen / risk)

---

## 约束

- **设计文档是权威**: NEW-01 按 `design-new01-codegen.md` 实现, H-11a 按 `design-h11a-tool-risk-levels.md` 实现
- **Phase 1A 是 gate**: 如果 spike 失败, 不要强行实现 Phase 1B, 而是记录失败并停止
- **双模型收敛**: 本轮为实现 (非设计), 单组件内部修改不需要多模型检查
- **不越界**: Phase 2 项目不触碰
- **无向后兼容负担**: 直接 breaking change, 不需要 deprecation shim

## 参考文件

| 文件 | 用途 |
|------|------|
| `meta/docs/design-new01-codegen.md` | NEW-01 设计 (R3 CONVERGED, 权威来源) |
| `meta/docs/design-h11a-tool-risk-levels.md` | H-11a 设计 (权威来源) |
| `meta/remediation_tracker_v1.json` | 项目追踪器 |
| `meta/schemas/` | 18 个 JSON Schemas (NEW-01 输入) |
| `packages/shared/src/tool-names.ts` | H-16a 工具名常量 (H-11a 消费) |
| `packages/hep-mcp/src/tools/registry.ts` | 主工具注册表 |
| `packages/hep-mcp/src/tools/dispatcher.ts` | 工具调度器 (H-11a `_confirm` 实现位置) |

## 不在范围

- NEW-01 设计变更 (设计已 CONVERGED, 只实现)
- Tier 2 quick wins (M-01, M-14a, UX-06, NEW-R02, H-13 — 推迟到下一轮对话)
- H-11b 权限组合 (Phase 2)
- NEW-R15-impl 编排器执行 (Phase 2)
- NEW-05a Stage 4 (CLI migration)
