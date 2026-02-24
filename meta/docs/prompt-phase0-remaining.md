# Prompt: Phase 0 剩余项实施

> 本 prompt 用于新开 Claude Code 对话，继续 REDESIGN_PLAN.md Phase 0 实施。
> 工作目录: `/home/user/Coding/Agents/autoresearch-lab/`（monorepo）

---

## 已完成

- **NEW-05** Monorepo 迁移 ✅ (2026-02-24)
- **NEW-R13** 包重命名 @hep-research/* → @autoresearch/*, hep-research-mcp → hep-mcp ✅ (2026-02-24)

Monorepo 位于 `/home/user/Coding/Agents/autoresearch-lab/`。696 tests pass, 8 TS packages build OK。

## 待执行 (11 项)

按依赖拓扑排序。**NEW-05a 依赖 NEW-05（已完成），其余无互相依赖，可并行。**

### 关键路径项

| ID | 标题 | 复杂度 | 位置 |
|----|------|--------|------|
| NEW-05a | 编排层与 idea 引擎迁移至 TypeScript | high | `packages/orchestrator/`（已有空 scaffold） |

NEW-05a Phase 0 交付仅限 Stage 1：最小 TS 编排器骨架（StateManager, LedgerWriter, McpClient, ApprovalGate）。详见 `meta/REDESIGN_PLAN.md` §NEW-05a。

### 并行独立项

| ID | 标题 | 复杂度 | 位置 |
|----|------|--------|------|
| C-01 | 审批 watchdog 执行闭环 | medium | `packages/hep-autoresearch/` |
| C-02 | Shell 执行隔离 | medium | `packages/hep-autoresearch/` |
| C-03 | 工具清单自动生成 | low | `packages/hep-mcp/` |
| C-04 | 合约快照同步 CI 门禁 | low | `packages/idea-core/` |
| H-08 | 输入净化层 | low | `packages/idea-core/` + `packages/shared/` |
| H-14a | McpStdioClient 保留 error_code | low | `packages/hep-autoresearch/` |
| H-20 | 配置加载一致性 | low | `packages/hep-mcp/` + `packages/hep-autoresearch/` |
| NEW-R02a | CODE-01 CI gate 脚本实现 | medium | `meta/scripts/` |
| NEW-R03a | Python 静默异常 P0 审计 (35 sites) | medium | `packages/hep-autoresearch/` + `packages/idea-core/` |
| NEW-R15-spec | 编排器 MCP 工具架构规格 | low | `meta/docs/` |

## 第一步: 读取上下文

1. 读取 `meta/REDESIGN_PLAN.md` 中 Phase 0 各项的详细规格
2. 读取 `meta/remediation_tracker_v1.json` 确认当前状态
3. 检查 serena memory: `architecture-decisions`
4. 读取 `packages/hep-mcp/CLAUDE.md`（TS 约束）

## 第二步: 执行策略

**推荐批次划分**（按 Python/TS 分组减少上下文切换）：

**Batch 1 — Python 安全/治理** (C-01, C-02, H-14a)：
- 同一代码库 `packages/hep-autoresearch/`
- C-01: `check_approval_timeout()` + `check_approval_budget()`
- C-02: 命令黑名单 + 路径白名单 + `ResourceLimiter`
- H-14a: `McpToolCallResult.error_code` 字段

**Batch 2 — TS 工具面** (C-03, H-08 TS 部分, H-20)：
- C-03: `scripts/generate_tool_catalog.ts`
- H-08: `packages/shared/src/sanitize.ts`
- H-20: `packages/hep-mcp/src/index.ts` dotenv 加载

**Batch 3 — CI/审计** (C-04, NEW-R02a, NEW-R03a)：
- C-04: `check_contract_drift.sh`
- NEW-R02a: `check_loc.py` + `check_entry_files.py`
- NEW-R03a: 35 个 `except Exception: pass` 站点审计

**Batch 4 — 规格文档** (NEW-R15-spec)：
- 编排器 MCP 工具架构规格文档

**Batch 5 — NEW-05a Stage 1**：
- TS 编排器骨架实现

## 第三步: 每 batch 完成后

1. 运行 `pnpm -r build && pnpm -r test` 验证无回归
2. 更新 `meta/remediation_tracker_v1.json` 中对应项 status → `"done"`
3. 提交

## 验收总检查点

- [ ] 全部 13 项 Phase 0 通过各自验收检查点（详见 REDESIGN_PLAN）
- [ ] `pnpm -r build && pnpm -r test` 全绿
- [ ] `meta/remediation_tracker_v1.json` 全部 Phase 0 项 status = "done"
- [ ] 无安全回归（路径穿越、命令注入测试通过）

## 注意事项

- 代码用英文，对话用中文
- 不要使用 superpowers brainstorming skill（REDESIGN_PLAN 已有完整规格，直接执行）
- 每个 item 的详细规格（修改文件、验收检查点）在 REDESIGN_PLAN §Phase 0 中已完整定义，直接跟着做
- 如有疑问先查 REDESIGN_PLAN，不足时再问用户
