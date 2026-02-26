# Phase 2 Batch 4 — Observability + Schema Consolidation + Migration Infrastructure

## 前置状态

- Phase 0: ALL DONE (14/14)
- Phase 1: 18/22 done (remaining: NEW-R03b/UX-01/UX-05 deferred)
- Phase 2: 20/43 done
  - Batch 1 ✅: H-07, H-11b, H-12, H-15b, H-17 (reliability + safety)
  - Phase 2A ✅: NEW-RT-02, NEW-RT-03 (reconnect, span tracing)
  - Phase 2B ✅: NEW-CONN-02 (review feedback)
  - Batch 2 ✅: M-19, H-16b, M-21, M-05, M-02, M-06 (contracts + observability + payload)
  - Batch 3 ✅: H-05, H-09, H-10, H-21, M-23, NEW-R07 (data paths + file lock + CAS + event enum + coverage gate)
- REDESIGN_PLAN: v1.8.0-draft
- **总进度**: 52/135
- **Last commits**: `864ad98` (deadlock fix + review completeness rule), `e5ec656` (TOCTOU tests), `7f1fe89` (Batch 3 impl)

## 本批目标

Phase 2 第四层——可观测性完善 + schema 整合 + 迁移基础设施。Batch 3 完成了 Python 侧 file lock/CAS/event enum 基础，现在构建 trace→JSONL 管线和 schema SSOT。

**本批 4 项** (跨语言):

| # | ID | 标题 | 估计 LOC | 依赖 | 语言 | 解锁 |
|---|-----|------|---------|------|------|------|
| 1 | M-20 | 迁移注册表 | ~80 | H-15b ✅, H-21 ✅ | Python + JSON Schema | artifact 版本升级 |
| 2 | trace-jsonl | 全链路 trace_id + JSONL 日志 | ~150 | H-02 ✅, H-01 ✅ | TS + Python | 可观测性闭环 |
| 3 | NEW-R06 | 分析类型 Schema 整合 | ~100 | NEW-01 ✅ | JSON Schema + codegen | 减少 schema 分散 |
| 4 | NEW-R05 | 证据抽象层 Schema SSOT | ~200 | NEW-01 ✅, H-18 ✅ | JSON Schema + codegen | 证据类型统一 |

**总估计**: ~530 LOC

完成后 Phase 2 进度: 24/43 done (从 20 升至 24)。
解锁: 可观测性闭环 (trace_id→JSONL aggregation), schema SSOT for evidence + analysis types.

---

## 执行前必读

1. `serena:read_memory` → `architecture-decisions.md` 和 `codebase-gotchas.md`
2. Claude Code auto memory → `memory/MEMORY.md` 和 `memory/batch-workflow.md`
3. 读 `meta/REDESIGN_PLAN.md` 中各项详细规格（搜索对应 item ID）
4. 读 `packages/shared/src/tracing.ts` — 现有 trace_id 生成/提取逻辑
5. 读 `packages/hep-mcp/src/tools/dispatcher.ts` — 现有 trace_id 使用
6. 读 `packages/hep-mcp/src/core/evidence.ts` — 现有证据类型定义
7. 读 `meta/schemas/` — 现有 18 个 schema

---

## Item 1: M-20 — 迁移注册表

**REDESIGN_PLAN 行号**: 搜索 `M-20`

**范围**: 定义 migration registry schema + 实现 `workspace migrate` 命令。

**实现**:
1. 创建 `meta/schemas/migration_registry_v1.schema.json`:
   - 定义 migration chain: `{schema_id, versions: [{from, to, migration_fn}]}`
   - 用 JSON Schema Draft 2020-12
2. 创建 `packages/hep-autoresearch/src/hep_autoresearch/toolkit/migrate.py`:
   - `detect_old_artifacts(repo_root)`: 扫描 `.autoresearch/` 下的 JSON 文件，检查 `schema_version`
   - `migrate_artifact(path, registry)`: 按 migration chain 应用升级
   - `cmd_migrate(repo_root)`: CLI 入口
3. 在 `orchestrator_cli.py` 添加 `workspace migrate` 子命令
4. 测试: `test_migrate.py` — N-1 版本 fixture 可升级，升级后通过当前 schema 验证

**验收**:
- [ ] N-1 version fixture can be upgraded via `workspace migrate`
- [ ] Migrated artifact passes current-version schema validation

---

## Item 2: trace-jsonl — 全链路 trace_id + 结构化 JSONL 日志

**REDESIGN_PLAN 行号**: 搜索 `全链路 trace_id`

**范围**: 统一 JSONL 日志格式，从 MCP dispatcher → orchestrator → ledger 贯穿 trace_id。

**实现**:
1. Python 侧: 创建 `packages/hep-autoresearch/src/hep_autoresearch/toolkit/logging_config.py`:
   - JSONL 格式: `{ts, level, component, trace_id, event, data}`
   - 保留 CLI 的人类可读输出（stderr human-readable, 文件输出 JSONL）
   - 组件标识: `"orchestrator"`, `"ledger"`, `"mcp_client"`
2. TS 侧: 在 `dispatcher.ts` 添加 tool invocation JSONL 输出:
   - 格式同 Python 侧: `{ts, level, component: "mcp_server", trace_id, event: "tool_call", data: {tool_name, duration_ms, success}}`
   - 输出到 stderr（与 MCP stdio 协议不冲突）
3. R7 扩展事件类型 (为 EVO-12a 准备):
   - 在 JSONL event 规范中预定义: `file_edit`, `fix_applied`, `tool_call`, `skill_invoked`
   - 只定义 schema，不实现发射逻辑
4. 测试: `test_logging_config.py` — JSONL 输出可被 jq 解析, trace_id 贯穿

**验收**:
- [ ] All component logs can be parsed by unified aggregation tool (`jq`)
- [ ] `trace_id` spans across MCP → orchestrator → ledger

---

## Item 3: NEW-R06 — 分析类型 Schema 整合

**REDESIGN_PLAN 行号**: 搜索 `NEW-R06`

**范围**: 将 7 个分散的分析结果版本文件整合为单一 `analysis_results_v1.schema.json`。

**实现**:
1. 审计现有分析结果类型:
   - 搜索 `packages/hep-mcp/src/` 下所有 `analysis` 相关类型定义
   - 识别 7 个版本化文件（如 REDESIGN_PLAN 所述）
2. 创建 `meta/schemas/analysis_results_v1.schema.json`:
   - 合并所有分析结果字段为单一 schema
   - 使用 `oneOf` 或 `discriminator` 区分不同分析类型
3. 运行 codegen pipeline 生成 TS + Python 类型:
   - `pnpm run codegen` 或等效命令
4. 替换手写类型定义:
   - TS 侧: 用 codegen 生成的类型替换 hand-written definitions
   - Python 侧: 如有消费方，同样替换
5. 测试: schema 通过 JSON Schema Draft 2020-12 验证

**验收**:
- [ ] Single canonical schema replaces versioned files
- [ ] Codegen replaces versioned analysis result files
- [ ] Existing tests pass (no regression)

---

## Item 4: NEW-R05 — 证据抽象层 Schema SSOT

**REDESIGN_PLAN 行号**: 搜索 `NEW-R05`

**范围**: 将 evidence types 从 TS 手写定义迁移到 JSON Schema SSOT + codegen。

**现有结构**:
- `packages/hep-mcp/src/core/evidence.ts`: `EvidenceType` (9 types), `LatexLocatorV1`, `EvidenceCatalogItemV1`
- `packages/hep-mcp/src/core/pdf/evidence.ts`: `PdfEvidenceType` (2 types), `PdfEvidenceCatalogItemV1`

**实现**:
1. 创建 `meta/schemas/evidence_catalog_item_v1.schema.json`:
   - 合并 LaTeX 和 PDF evidence types
   - `EvidenceType` enum: 9 LaTeX types + 2 PDF types
   - 包含 `LatexLocatorV1` 和 `PdfLocatorV1` 作为 `$ref` 子 schema
   - `ArtifactRefV1` 通过 `$ref` 组合，不重复 `sha256`/`size_bytes` 字段
2. 运行 codegen pipeline → 生成 TS + Python 类型
3. 替换 `core/evidence.ts` 和 `core/pdf/evidence.ts` 中的手写类型
4. 确保所有导入方使用新 codegen 类型
5. 测试: schema 验证 + 现有 evidence 相关测试通过

**边界**: `ArtifactRefV1` (H-18) 已有 schema → evidence schema 通过 `$ref` 组合引用。

**验收**:
- [ ] Evidence schema passes JSON Schema Draft 2020-12 validation
- [ ] Codegen-generated TS/Python types replace hand-written definitions
- [ ] `ArtifactRefV1` composed via `$ref`, no field duplication

---

## 执行流程

1. 依次实现 Item 1-4（可按任意顺序，无内部依赖）
2. 每个 item 完成后运行对应测试
3. 全部完成后: `pnpm -r test` + `python -m pytest tests/ -x -q` + `make test-coverage-gate`
4. 双模型收敛审核 (review-swarm): 准备 system prompt + review packet → 运行
5. 修复 BLOCKING issues → 迭代至收敛
6. Commit → push → 更新 REDESIGN_PLAN checkboxes + tracker
7. 生成 Batch 5 prompt

---

## 注意事项

- **无向后兼容负担**: 直接 breaking change，不需要 deprecation shim
- **codegen pipeline**: `meta/schemas/` → codegen → TS/Python 类型 (NEW-01 已就绪)
- **测试**: 新增源文件必须有对应测试文件 (NEW-R07 gate)
- **Codex 审核慢**: Codex CLI 在 review-swarm 中可能需要 10-15 分钟，耐心等待，不要提前截断
- **审核完整性**: 每个模型必须至少完成一次对完整实现的审核才能计入收敛（见 CLAUDE.md §完整性要求）
- **并行开发注意**: nds-mcp 可能在 worktree `../autoresearch-nds` 上并行开发。Batch 4 在 main 上工作，不要切换到 `feat/nds-mcp` branch。两者文件无交集。
