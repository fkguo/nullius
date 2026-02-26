# Phase 2 Batch 2 — Contracts + Observability + Payload Discipline

## 前置状态

- Phase 0: ALL DONE (14/14)
- Phase 1: 18/22 done (remaining: M-19 now unblocked by H-17, NEW-R03b/UX-01/UX-05 deferred)
- Phase 2: 8/43 done
  - Batch 1 ✅: H-07 (atomic writes), H-11b (permission composition), H-12 (sandbox), H-15b (artifact versioning), H-17 (compatibility handshake)
  - Phase 2A ✅: NEW-RT-02 (reconnect), NEW-RT-03 (span tracing)
  - Phase 2B ✅: NEW-CONN-02 (review feedback next_actions)
- REDESIGN_PLAN: v1.8.0-draft
- **总进度**: 40/135
- **Last commits**: `daefe0b` (R1 review fixes), `43bf4cd` (review-swarm parity), `d9df83c` (Batch 1 impl), `fca9706` (vnext→core rename)

## 本批目标

Phase 2 第二层——契约执行 + 可观测性 + 载荷纪律。在 Batch 1 的可靠性/安全基础之上，建立跨组件契约门禁、结构化日志、载荷大小控制和 token 计量标准。

**Phase 1 收尾**: M-19 (CI 集成测试) 的唯一 blocker H-17 已在 Batch 1 完成。本批顺带收尾。

**本批 6 项** (全部 TS + CI/build):

| # | ID | 标题 | 估计 LOC | 依赖 | 解锁 |
|---|-----|------|---------|------|------|
| 1 | M-19 | CI 集成测试 (Phase 1 收尾) | ~80 | H-17 ✅ | H-16b 实质前置 |
| 2 | H-16b | 跨组件契约测试 CI | ~120 | H-16a ✅, H-17 ✅ | M-20 路径 |
| 3 | M-21 | 载荷大小/背压契约 | ~120 | H-13 ✅ | 无 |
| 4 | M-05 | Token 计数标准化 | ~80 | 无 | 写作 pipeline 精度 |
| 5 | M-02 | 遗留工具名迁移 | ~60 | H-16a ✅ | 无 |
| 6 | M-06 | SQLite WAL + 连接池 | ~120 | 无 | EVO-20/19/21 基座 |

**总估计**: ~580 LOC

完成后 Phase 2 进度: 14/43 done (从 8 升至 14)。
解锁: M-20 (迁移注册表, 需 H-15b ✅ + H-21), trace-jsonl (下批).

---

## 执行前必读

1. `serena:read_memory` → `architecture-decisions.md` 和 `codebase-gotchas.md`
2. Claude Code auto memory → `memory/MEMORY.md` 和 `memory/batch-workflow.md`
3. 读 `meta/REDESIGN_PLAN.md` 中各项详细规格（行号见下方各 item）
4. 读 `Makefile` 中已有的 CI/test targets

---

## Item 1: M-19 — CI 集成测试 (Phase 1 收尾)

**REDESIGN_PLAN 行号**: 搜索 `M-19`

**范围**: 确保 `make test` + `make lint` 能在 CI (GitHub Actions) 中运行，覆盖 TS + Python 子包。

**实现**:
1. 检查 `.github/workflows/ci.yml` 是否存在；如不存在则创建
2. CI workflow:
   - `pnpm install && pnpm -r build && pnpm -r test && pnpm -r lint`
   - Python tests: `cd packages/hep-autoresearch && python -m pytest`（如果有 Python 测试）
3. 确保 `make test` 在 monorepo 根目录包含所有子包测试

**验收**: CI workflow 定义完成，本地 `make test` 全部通过。

---

## Item 2: H-16b — 跨组件契约测试 CI

**REDESIGN_PLAN 行号**: ~1038

**范围**: 验证 hep-autoresearch 调用的 MCP 工具集合 ⊂ hep-mcp 注册表。利用 H-17 的 `computeToolCatalogHash` 和 H-16a 的 `TOOL_NAMES` 常量。

**实现**:
1. 新增 `packages/hep-mcp/tests/contracts/crossComponentToolSubset.test.ts`:
   - 从 `registry.ts` 获取 `getTools('standard')` 和 `getTools('full')` 的工具名集合
   - 从 `packages/shared/src/tool-names.ts` (H-16a 产物) 获取 `TOOL_NAMES`
   - 断言: `TOOL_NAMES ⊂ getTools('full')` — 共享常量中的每个工具名都存在于注册表
2. 新增 Makefile target: `contract-test` 运行契约测试
3. 确保 CI workflow 包含 `make contract-test`

**关键**: 不要测试 Python 侧 (hep-autoresearch) 的工具调用——那部分是 Python 编排器，本批不碰。只测 TS 侧的一致性。

**验收**:
- 新增/删除 MCP 工具后，如果不更新 `TOOL_NAMES` → 契约测试失败
- `computeToolCatalogHash` 可作为 CI artifact 存档用于版本比较

---

## Item 3: M-21 — 载荷大小/背压契约

**REDESIGN_PLAN 行号**: ~1125

**范围**: 定义并强制 stdio tool result 的大小限制 (100KB)。超限结果已由 H-13 溢出到 artifact，本项补全两个 R2 遗留:
1. `inspire_literature` 的 `get_references`/`get_citations` 裸数组返回值须经 `compactPaperSummary` 处理
2. `appendResourceLinks()` MIME 类型须从 `hep://` URI 推断

**实现**:
1. 在 `packages/shared/src/constants.ts` (或新文件) 定义 `STDIO_MAX_RESULT_BYTES = 100 * 1024`
2. 在 dispatcher.ts 中，H-13 truncation 逻辑改用此常量（替代硬编码值，如果有的话）
3. 修复 R2 caveat #1: 找到 `inspire_literature` handler 中 `get_references`/`get_citations` 分支，确保裸数组经过 `compactPaperSummary` 压缩后再返回
4. 修复 R2 caveat #2: `appendResourceLinks()` 中 MIME 类型推断——`hep://` URI 含 artifact name，可据此推断 (`.json` → `application/json`，`.jsonl` → `application/x-ndjson`，`.md` → `text/markdown`，其他 → `application/octet-stream`)
5. 新增测试验证大小限制常量被使用

**验收**: 超限 tool result 自动溢出；R2 caveats 修复。

---

## Item 4: M-05 — Token 计数标准化

**REDESIGN_PLAN 行号**: ~1080

**范围**: writing pipeline 的 token budget/gate 工具增加 `tokenizer_model` 参数，文档化估算公式。

**实现**:
1. 读 `packages/hep-mcp/src/core/writing/tokenBudget.ts` 和 `tokenGate.ts`
2. 在相关 Zod schema 中新增 optional `tokenizer_model?: string` 参数（默认 `claude-opus-4-6`）
3. 如果当前 token 估算用了硬编码的字符/token 比率，将其文档化并参数化
4. 在工具 handler 中记录使用的 tokenizer_model 到 artifact metadata
5. 新增测试：传入不同 `tokenizer_model` 值，验证参数被传递（不需要实际调用 tokenizer）

**验收**: token budget/gate 工具接受 `tokenizer_model` 参数。

---

## Item 5: M-02 — 遗留工具名迁移

**REDESIGN_PLAN 行号**: ~1066

**范围**: 移除/统一遗留工具名引用。

**实现**:
1. 搜索代码中所有 `inspire_field_survey` 引用 → 替换为 `inspire_research_navigator`
2. 可选: 在 `registry.ts` 添加 deprecated alias 映射 + 警告日志 (如果外部消费者可能仍用旧名)
3. 考虑到"无向后兼容负担"约束 (CLAUDE.md)，优先直接替换而非加 alias
4. 运行 `pnpm -r test` 确保无回归

**注意**: 如果 `inspire_field_survey` 在 Python 侧 (hep-autoresearch) 也有引用，仅替换 TS 侧。Python 侧在未来 batch 处理。

**验收**: TS 代码中无遗留工具名引用。

---

## Item 6: M-06 — SQLite WAL + 连接池

**REDESIGN_PLAN 行号**: ~1094

**范围**: PDG SQLite 数据库连接设置 WAL 模式 + busy_timeout；在 `packages/shared` 中创建通用 SQLite 工具模块供未来 EVO-20/19/21 消费。

**实现**:
1. 新增 `packages/shared/src/db/sqlite-utils.ts`:
   - `configureSqliteWal(db: Database): void` — 设置 `PRAGMA journal_mode=WAL` + `PRAGMA busy_timeout=5000`
   - `openSqliteDb(path: string, opts?): Database` — 打开 + 配置 WAL + 返回
   - **注意**: `packages/shared` 是 platform-agnostic，不能直接 import `better-sqlite3`。定义接口/类型，让消费者注入具体实现。或者如果 `better-sqlite3` 已在 shared 的依赖中，直接使用。
2. 检查 `packages/pdg-mcp/src/db.ts` 的当前实现，添加 WAL 配置
3. 新增测试验证 WAL 模式

**关键决策**: 检查 `packages/shared/package.json` 是否有 `better-sqlite3` 依赖。如果没有（platform-agnostic 约束），则：
- 在 `shared` 中只定义 `SqliteConfig` 接口和常量
- 在 `pdg-mcp` 中实现具体的 WAL 配置
- 在 Batch 2 的 review packet 中说明这个架构决策

**验收**: WAL 模式在连接后验证；并发读写不触发 `database is locked`。

---

## 执行顺序

1. M-19 (CI 基座) → H-16b (契约测试需要 CI) → 其余四项可并行
2. M-21 需要先读 H-13 的 truncation 代码
3. M-06 需要先检查 shared 的 platform-agnostic 约束

---

## 验收

```bash
pnpm -r build     # 0 errors
pnpm -r test      # 所有测试通过 (expect 677+ tests)
pnpm -r lint      # 0 errors
make test         # 全 monorepo 测试
```

---

## 双模型收敛审核

实现完成、build + test 通过后：

### 1. 准备审核材料

```bash
# System prompt (同 Batch 1)
cp /tmp/phase2-batch1-system.md /tmp/phase2-batch2-system.md

# Review packet: 写入本批的上下文 + diff
# (格式参照 /tmp/phase2-batch1-review-packet.md)

# Full prompt = system + review packet
cat /tmp/phase2-batch2-system.md > /tmp/phase2-batch2-full-prompt.md
echo -e "\n\n---\n" >> /tmp/phase2-batch2-full-prompt.md
cat /tmp/phase2-batch2-review-packet.md >> /tmp/phase2-batch2-full-prompt.md
```

### 2. 运行 review-swarm

```bash
python3 skills/review-swarm/scripts/bin/run_multi_task.py \
  --out-dir /tmp/phase2-batch2-r1-review \
  --system /tmp/phase2-batch2-system.md \
  --prompt /tmp/phase2-batch2-full-prompt.md
```

### 3. 收敛循环

- **CONVERGED** (0 BLOCKING from all models): 进入提交流程
- **NOT_CONVERGED** (any BLOCKING): 修复 → R+1 → 重新 review
- 最多 5 轮

---

## 收敛后操作

1. **Commit**: 一个功能 commit (6 items) + 可能的 review fix commit(s)
2. **Push**: `git push`
3. **Update REDESIGN_PLAN.md**: 勾选已完成的验收检查点 + 更新进度行
4. **Update tracker**: `meta/remediation_tracker_v1.json` 对应 items → `"status": "done"`
5. **Update Serena memory**: `architecture-decisions.md` 记录本批架构决策

---

## 自续 Prompt 生成（关键步骤）

收敛 + commit + push 完成后，**必须**在本会话结束前执行以下操作：

### 步骤

1. 读 `meta/REDESIGN_PLAN.md`，识别所有 Phase 2 中**依赖已满足但尚未完成**的条目
2. 根据以下原则分组为下一批 (Batch 3):
   - **主题一致性**: 选择有逻辑关联的 items (如 "schema + codegen", "Python 编排器", "pipeline 连通" 等)
   - **LOC 控制**: 总估计 ~500-800 LOC，单 session 可完成
   - **解锁价值**: 优先选择能解锁后续 items 的
   - **语言一致性**: 尽量同一语言 (TS 或 Python)，避免频繁切换
3. 写入 `meta/docs/prompt-phase2-impl-batch3.md`，格式与本文件一致:
   - 更新前置状态 (进度计数、最近 commits)
   - 本批 items 表格 + 解锁关系
   - 各 item 详细实现指导
   - 验收命令
   - 双模型审核指令
   - **包含本段"自续 Prompt 生成"指令**（递归）
4. 告知用户: "下一批 prompt 已写入 `meta/docs/prompt-phase2-impl-batch3.md`，新开对话执行即可。"

### 下一批候选 items (供参考，实际选择需基于执行时的最新状态)

Phase 2 中本批完成后**可能**解锁的 TS 项:
- **trace-jsonl**: 全链路 JSONL 日志 (deps: H-02 ✅, H-01 ✅, M-14a ✅)
- **M-23**: 发布产物对齐 (deps: H-16a ✅)
- **NEW-R05**: 证据抽象层 (deps: NEW-01 ✅, H-18 ✅)
- **NEW-R06**: 分析类型 Schema 整合 (deps: NEW-01 ✅)
- **NEW-VIZ-01**: Graph Visualization Layer (no deps)
- **NEW-IDEA-01**: idea-core MCP 桥接 (deps: H-01~03 ✅, H-16a ✅, ~400-800 LOC, 大项)

Phase 2 中本批完成后**可能**解锁的 Python 项:
- **H-05**: 跨平台文件锁 (deps: H-01 ✅, H-03 ✅)
- **H-09**: 幂等性 CAS (deps: H-01 ✅)
- **H-10**: Ledger 事件枚举 (deps: H-03 ✅)
