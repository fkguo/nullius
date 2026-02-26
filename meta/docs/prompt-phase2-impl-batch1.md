# Phase 2 Batch 1 — Foundation: Reliability + Safety (vnext rename + H-07 + H-15b + H-17 + H-11b + H-12)

## 前置状态

- Phase 0: ALL DONE (14/14)
- Phase 1 Batch 1–5: 18/22 done (remaining: M-19 blocked→H-17, NEW-R03b/UX-01/UX-05 deferred→Python 退役路径)
- Phase 2A: 2/3 done (NEW-RT-02 ✅, NEW-RT-03 ✅; NEW-RT-01 blocked on NEW-R15-impl)
- Phase 2B: 1/40 done (NEW-CONN-02 ✅)
- REDESIGN_PLAN: v1.8.0-draft (commit 25dfc6e)
- **总进度**: 35/135

## 本批目标

Phase 2 基础层——可靠性 + 安全性。这些 TS 项全部依赖已满足，为后续连通性条目（NEW-CONN-03/04、NEW-WF-01 等）铺路。

**前置清理**: `src/vnext/` 是 MCP 早期开发的历史遗留命名，现在 vnext 就是唯一实现。先做纯机械重命名 `vnext/` → `core/`，独立 commit，再做功能项。

**Phase 1 收尾决策**:
- M-19 (CI 集成测试): BLOCKED on H-17。本批完成 H-17 后下批可做。
- NEW-R03b: Python 退役路径 281 个 exception handler，ROI 低。推迟至 Python 模块实际修改时顺带处理。
- UX-01 + UX-05: Python 编排器模板拆分，不阻塞 Phase 2 任何 TS 项。推迟。

**本批 6 项** (全部 TS):

| # | ID | 标题 | 估计 LOC / 改动量 | 依赖 |
|---|-----|------|---------|------|
| 0 | — | `vnext/` → `core/` 目录重命名 | ~170 处 import 路径 (0 逻辑变更) | 无 |
| 1 | H-07 | Atomic file writes | ~120-150 | 无 |
| 2 | H-15b | Artifact 版本标记统一 | ~80-120 | H-18 ✅, M-01 ✅ |
| 3 | H-17 | 运行时兼容性握手 | ~100-120 | C-03 ✅ |
| 4 | H-11b | MCP 权限组合策略 | ~100-150 | H-11a ✅, H-04 ✅ |
| 5 | H-12 | 不可信内容沙箱 | ~150-200 | C-02 ✅ |

完成后解锁:
- M-19 (H-17 ✅ → CI 集成测试)
- H-16b (H-17 ✅ → 跨组件 contract testing)
- 后续 Phase 2 连通项可安全依赖 atomic writes + sandbox

---

## 执行前必读

1. `serena:read_memory` → `architecture-decisions.md` 和 `codebase-gotchas.md`
2. 读 `meta/REDESIGN_PLAN.md` 中各项详细规格（行号见下）
3. 读 `Makefile`（已有 `code-health-check` target，新增项须集成）

---

## Item 0: `vnext/` → `core/` 目录重命名 (独立 commit)

> **背景**: `src/vnext/` 是 MCP server 早期开发时引入的命名，用于区分旧实现和新实现。现在旧代码已经清理完毕，`vnext` 就是正式的唯一实现层，名称已失去意义。

**约束**:
- **纯机械重命名，零逻辑变更**。
- **独立 commit** — 不与功能项混合，方便 review 时 `git diff --diff-filter=R` 确认全部是 rename。
- 测试目录同步: `tests/vnext/` → `tests/core/`

**操作步骤**:

1. **目录移动**:
   ```bash
   cd packages/hep-mcp
   git mv src/vnext src/core
   git mv tests/vnext tests/core
   ```

2. **批量替换 import 路径** — 涉及 ~170 处跨 55 个文件:

   需要替换的模式（按影响量排序）:

   | 位置 | 文件数 | 说明 |
   |------|--------|------|
   | `src/vnext/` 内部互相引用 | ~66 个 | `../vnext/` → `../core/`、相对路径不变的无需改 |
   | `src/tools/registry.ts` | 1 (20 处) | `from '../vnext/...` → `from '../core/...` |
   | `src/tools/dispatcher.ts` | 1 (3 处) | 同上 |
   | `src/tools/research/*.ts` | 2 (~18 处) | 同上 |
   | `src/tools/writing/**/*.ts` | 3 (~5 处) | 同上 |
   | `src/index.ts` | 1 (1 处) | 同上 |
   | `tests/core/` (原 `tests/vnext/`) | ~45 个 | `from '../../src/vnext/...` → `from '../../src/core/...` |

   **推荐命令**:
   ```bash
   # src/ 中引用 vnext 的文件 (vnext 目录已移动为 core，内部相对路径自动正确)
   # 只需要修改 vnext 目录外部的引用
   find src -not -path '*/core/*' -name '*.ts' -exec sed -i '' "s|/vnext/|/core/|g" {} +
   find tests -name '*.ts' -exec sed -i '' "s|/vnext/|/core/|g" {} +
   ```

3. **验证**:
   ```bash
   pnpm -r build && pnpm -r test   # 零回归
   grep -r 'vnext' src/ tests/ --include='*.ts' -l  # 应为空 (0 残留)
   ```

4. **独立 commit**:
   ```
   refactor: rename vnext/ → core/ — remove legacy naming (0 logic changes)
   ```

**验收**:
- `packages/hep-mcp/src/vnext/` 不存在
- `packages/hep-mcp/tests/vnext/` 不存在
- `grep -r 'vnext' packages/hep-mcp/src/ packages/hep-mcp/tests/ --include='*.ts'` 返回 0 结果
- `pnpm -r build && pnpm -r test` 全部通过
- **独立 commit**，不含任何功能变更

---

## Phase 2 Batch 1 功能项 (Item 0 完成后)

> **注意**: 以下所有路径已反映 Item 0 重命名后的状态 (`src/core/` 而非 `src/vnext/`)。

### 1. H-07: Atomic File Writes (~120-150 LOC)

参考 `meta/REDESIGN_PLAN.md` H-07 节（约 line 951）。依赖: 无。

**问题**: 当前 `writeRunJsonArtifact` / `writeRunArtifact` 使用 `fs.writeFileSync`，进程崩溃时可产生截断/损坏的 artifact 文件。

**实现**:

- `packages/shared/src/atomicWrite.ts` (新文件):
  ```typescript
  export function atomicWriteFileSync(targetPath: string, data: string | Buffer): void
  ```
  策略: write to `${targetPath}.tmp.${pid}` → `fsync` fd → `rename()` (POSIX atomic on same filesystem)。
  - 使用 `process.pid` 避免并发写入冲突
  - 自动检测目标目录存在性（`mkdirSync` recursive if needed）
  - 错误时清理 `.tmp` 文件

- `packages/shared/src/index.ts`: 导出 `atomicWriteFileSync`

- `packages/hep-mcp/src/core/citations.ts` (`writeRunJsonArtifact` 等): 替换 `fs.writeFileSync` 为 `atomicWriteFileSync`

- `packages/hep-mcp/tests/core/atomicWrite.test.ts` (新文件):
  - 正常写入 → 文件内容正确
  - 目标目录不存在 → 自动创建
  - 并发写入不冲突（使用不同 pid 后缀）

**验收**:
- `atomicWriteFileSync` 通过单元测试
- `writeRunJsonArtifact` 使用 atomic write
- 全部测试通过

### 2. H-15b: Artifact 版本标记统一 (~80-120 LOC)

参考 `meta/REDESIGN_PLAN.md` H-15b 节（约 line 1024）。依赖: H-18 ✅, M-01 ✅。

**问题**: 部分 artifact 只有文件名 `_v1` 后缀但 JSON body 无 `version` / `schema_version` 字段，或反之。

**实现**:

- **审计**: 扫描所有 `writeRunJsonArtifact` 调用点，检查写入的 payload 是否包含 `version` 或 `schema_version` 字段。列出缺失项。

- **修复**: 对缺失 `version` 字段的 payload，在写入时确保包含 `version: 1`（或对应版本号）。原则:
  - 文件名 `_v{N}` 的 `N` 与 JSON body 中的 `version` / `schema_version` 字段必须一致
  - 只添加缺失字段，不改变已有逻辑

- **Lint 增强** (可选): 在 `meta/scripts/lint_artifact_names.py` 或新脚本中增加静态检查，扫描 payload 对象字面量中是否包含 `version` 字段。

**验收**:
- 所有 `writeRunJsonArtifact` 写入的 JSON payload 包含 `version` 或 `schema_version` 字段
- 文件名 `_v{N}` 与 body `version` 一致
- 全部测试通过

### 3. H-17: 运行时兼容性握手 (~100-120 LOC)

参考 `meta/REDESIGN_PLAN.md` H-17 节（约 line 576）。依赖: C-03 ✅。

**问题**: hep-autoresearch (Python 编排器) 启动后不验证 MCP server 版本兼容性，工具名/参数变更后默默失败。

**实现**:

- `packages/hep-mcp/src/core/health.ts` (已有 `hep_health` handler): 在返回值中追加 `tool_catalog_hash` 字段 — 对当前注册表所有 tool name 排序后取 SHA256 hex。
  ```typescript
  import { createHash } from 'crypto';
  const names = getTools(mode).map(t => t.name).sort();
  const tool_catalog_hash = createHash('sha256').update(names.join('\n')).digest('hex');
  ```

- `packages/hep-autoresearch/src/hep_autoresearch/toolkit/mcp_stdio_client.py`: 在 `connect()` 成功后调用 `hep_health` 获取 `tool_catalog_hash`；首次调用存入 `~/.hep-research-mcp/.tool_catalog_hash`；后续调用对比，若不一致 → `console.error` 警告（不中断）。

- `packages/hep-mcp/tests/core/health.test.ts`: 验证 `tool_catalog_hash` 为 64 字符 hex string 且在工具集不变时稳定。

**验收**:
- `hep_health` 返回 `tool_catalog_hash` 字段
- hash 在同一 tool 集下稳定（idempotent test）
- 全部测试通过

### 4. H-11b: MCP 权限组合策略 (~100-150 LOC)

参考 `meta/REDESIGN_PLAN.md` H-11b 节（约 line 997）。依赖: H-11a ✅, H-04 ✅。

**问题**: H-11a 给每个工具标记了 `riskLevel: read | write | destructive`，但缺少组合策略——多工具链如何判定整体风险级别。

**实现**:

- `packages/shared/src/tool-risk.ts` (已有): 新增:
  ```typescript
  export function composedRiskLevel(levels: ToolRiskLevel[]): ToolRiskLevel
  ```
  策略: `destructive > write > read` (取最高)。空数组返回 `read`。

- `packages/shared/src/tool-risk.ts`: 新增策略文档常量:
  ```typescript
  export const PERMISSION_POLICY = {
    destructive_requires_gate: true,   // A5 gate
    write_chain_requires_gate: false,  // 仅 destructive 需要 gate
    max_chain_length: 10,              // 链长上限
  } as const;
  ```

- `packages/hep-mcp/src/tools/dispatcher.ts`: 在 `handleToolCall` 中添加链长检查——如果 `_chain_depth` (从 args 中可选读取) 超过 `max_chain_length`，返回 `INVALID_PARAMS` 错误。

- 测试: 在 `packages/shared/tests/tool-risk.test.ts` (已有) 新增 `composedRiskLevel` 测试。

**验收**:
- `composedRiskLevel` 正确取最高风险级别
- `PERMISSION_POLICY` 常量可从 `@autoresearch/shared` 导入
- 全部测试通过

### 5. H-12: 不可信内容沙箱 (~150-200 LOC)

参考 `meta/REDESIGN_PLAN.md` H-12 节（约 line 1010）。依赖: C-02 ✅。

**问题**: 处理外部 PDF / ZIP / LaTeX 时无资源限制，存在 Zip Slip、解压炸弹等攻击面。

**实现**:

- `packages/shared/src/sandbox.ts` (新文件):
  ```typescript
  export interface ExtractOptions {
    maxTotalBytes?: number;    // default 500MB
    maxFileCount?: number;     // default 10000
    allowedExtensions?: string[]; // default: common safe types
  }
  
  export function safeExtractZip(archivePath: string, destDir: string, opts?: ExtractOptions): void
  ```
  安全措施:
  - **Zip Slip 防护**: 每个 entry 的 resolved path 必须在 `destDir` 内 (`path.resolve(destDir, entryName)` 以 `destDir` 开头)
  - **解压大小限制**: 累积解压字节数超过 `maxTotalBytes` → 抛出 `RESOURCE_LIMIT` 错误
  - **文件数量限制**: entry 数超过 `maxFileCount` → 抛出 `RESOURCE_LIMIT` 错误
  - **目录遍历检查**: 拒绝含 `..` 的 entry name

- `packages/shared/src/sandbox.ts`: 追加 PDF 解析资源限额:
  ```typescript
  export const PDF_RESOURCE_LIMITS = {
    maxPageCount: 800,
    maxFileSizeMB: 100,
    timeoutMs: 60_000,
  } as const;
  ```

- `packages/shared/tests/sandbox.test.ts` (新文件):
  - Zip Slip 路径 → 拒绝
  - 正常 zip → 解压成功
  - 超过文件数限制 → 错误
  - `..` 路径 → 拒绝

- **集成点** (可选，如果现有代码有 zip 解压): 替换裸 `unzip` 调用为 `safeExtractZip`。

**验收**:
- `safeExtractZip` 通过 Zip Slip + 解压炸弹 + 目录遍历测试
- `PDF_RESOURCE_LIMITS` 可从 `@autoresearch/shared` 导入
- 全部测试通过

---

## 执行约束

1. **实现顺序**: **Item 0 (vnext rename, 独立 commit)** → H-07 → H-15b → H-17 → H-11b → H-12（H-07 最先因为后续项可能用到 atomic write）
2. **每项完成后**跑对应测试；全部完成后 `pnpm -r build && pnpm -r test` 确认零回归
3. **全部完成后**执行双模型收敛检查:
   ```bash
   python3 skills/review-swarm/scripts/bin/run_multi_task.py \
     --out-dir /tmp/phase2-batch1-review \
     --system <system.md> \
     --prompt <review-packet.md>
   ```
   Codex gpt-5.3-codex (xhigh) + Gemini 3.1-pro-preview。收敛后 commit + push。
4. **REDESIGN_PLAN.md 更新**: 各项验收 checkbox 打 ✅；映射表行更新 done 计数；总计更新
5. **remediation_tracker_v1.json 更新**: 各项 `status: "pending"` → `"done"`, `completed_at` 填写
6. **Serena 记忆更新**: 写入 `architecture-decisions.md` (Phase 2 Batch 1 条目)
7. **路径映射注意**: REDESIGN_PLAN 中的旧路径需按 CLAUDE.md 工作区路径映射表转换
   - `autoresearch-meta/` → `meta/`
   - `hep-research-mcp/` → `packages/hep-mcp/`

## 完成后下一步建议

本批完成后 Phase 2 达 ~8/43 done，解锁:
- **M-19**: H-17 ✅ → CI 集成测试
- **H-16b**: H-17 ✅ → 跨组件 contract testing CI
- **Phase 2 Batch 2 候选** (连通性 + 清理):
  - M-19 + H-16b (刚解锁的 CI 项)
  - M-02 (legacy tool cleanup, deps met)
  - M-05 (token counting, no deps)
  - M-06 (SQLite WAL, no deps)
  - NEW-R05/R06 (schema consolidation, deps met)
