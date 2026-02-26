# Phase 2 Batch 3 — Data Paths + Observability + Python Foundation

## 前置状态

- Phase 0: ALL DONE (14/14)
- Phase 1: 18/22 done (remaining: NEW-R03b/UX-01/UX-05 deferred)
- Phase 2: 14/43 done
  - Batch 1 ✅: H-07, H-11b, H-12, H-15b, H-17 (reliability + safety)
  - Phase 2A ✅: NEW-RT-02, NEW-RT-03 (reconnect, span tracing)
  - Phase 2B ✅: NEW-CONN-02 (review feedback)
  - Batch 2 ✅: M-19, H-16b, M-21, M-05, M-02, M-06 (contracts + observability + payload)
- REDESIGN_PLAN: v1.8.0-draft
- **总进度**: 46/135
- **Last commits**: `0b12496` (tracker update), `4180266` (Batch 2 impl), `daefe0b` (R1 review fixes)

## 本批目标

Phase 2 第三层——数据路径统一 + 可观测性 + Python 侧基础设施。Batch 1-2 完成了 TS 侧的可靠性/契约/载荷基础，现在转向跨语言数据路径和 Python 侧退役前的质量基线。

**本批 6 项** (Python 为主 + TS/Makefile + 跨语言):

| # | ID | 标题 | 估计 LOC | 依赖 | 语言 | 解锁 |
|---|-----|------|---------|------|------|------|
| 1 | M-23 | 发布产物对齐 | ~60 | H-16a ✅ | TS/Makefile | 发布自动化 |
| 2 | H-21 | 数据存储位置统一 | ~80 | H-20 ✅ | Python | M-20 (迁移注册表) |
| 3 | H-10 | Ledger 事件类型枚举 | ~80 | H-03 ✅ | Python | trace-jsonl 基础 |
| 4 | H-05 | 跨平台文件锁 | ~120 | H-01 ✅, H-03 ✅ | Python | H-09, 并发安全 |
| 5 | H-09 | 幂等性 CAS | ~120 | H-01 ✅ | Python | 并发安全 |
| 6 | NEW-R07 | hep-autoresearch 测试覆盖门禁 | ~80 | 无 | Python/CI | 质量基线 |

**总估计**: ~540 LOC

完成后 Phase 2 进度: 20/43 done (从 14 升至 20)。
解锁: M-20 (迁移注册表, H-15b ✅ + H-21), trace-jsonl (H-10 事件枚举 ready).

---

## 执行前必读

1. `serena:read_memory` → `architecture-decisions.md` 和 `codebase-gotchas.md`
2. Claude Code auto memory → `memory/MEMORY.md` 和 `memory/batch-workflow.md`
3. 读 `meta/REDESIGN_PLAN.md` 中各项详细规格（行号见下方各 item）
4. 读 `packages/hep-autoresearch/` 目录结构，了解 Python 侧代码布局

---

## Item 1: M-23 — 发布产物对齐

**REDESIGN_PLAN 行号**: 搜索 `M-23`

**范围**: 创建 `make release` target，一键构建 TS + 生成 Python 绑定 + 版本号对齐。

**实现**:
1. 在 `Makefile` 新增 `release` target:
   - `pnpm -r build`
   - 如果有 `scripts/generate_tool_catalog.ts` → 运行之
   - 如果有 `scripts/generate_tool_names.py` → 运行之
   - 检查 `package.json` 和 `pyproject.toml` 版本号是否一致
2. 版本号对齐: 创建 `scripts/check_version_sync.sh` 或类似脚本
   - 从根 `package.json` 读 version
   - 从 `packages/hep-autoresearch/pyproject.toml` 和 `packages/idea-core/pyproject.toml` 读 version
   - 不一致则报错

**验收**:
- `make release` 一键构建并校验
- 版本不一致时报错

---

## Item 2: H-21 — 数据存储位置统一

**REDESIGN_PLAN 行号**: 搜索 `H-21`

**范围**: 统一 `HEP_DATA_DIR` 配置，使 Python 侧与 TS 侧一致。

**实现**:
1. TS 侧已将默认数据目录从 `~/.hep-research-mcp` 重命名为 `~/.hep-mcp`（与包名 hep-mcp 对齐）
2. 在 `packages/hep-autoresearch/src/hep_autoresearch/toolkit/mcp_stdio_client.py` 中:
   - 默认 `HEP_DATA_DIR` 为 `~/.hep-mcp`（与 TS 侧 dataDir.ts 一致）
   - 支持 `HEP_DATA_DIR` 环境变量覆盖
3. 同步更新 Python 侧所有 `~/.hep-research-mcp` 引用为 `~/.hep-mcp`（涉及 `orchestrator_cli.py`, `mcp_config.py`, `project_scaffold.py`, `method_design.py`, `.hep/workspace.json`, `.gitignore` 等）
4. 确保 `hepar status` / `hepar run` 等命令能正确发现 artifacts
5. 文档说明 `HEP_DATA_DIR=.` 为项目相对模式

**验收**:
- `HEP_DATA_DIR` 环境变量覆盖默认值
- Python 测试覆盖默认值和 env 覆盖

---

## Item 3: H-10 — Ledger 事件类型枚举

**REDESIGN_PLAN 行号**: 搜索 `H-10`

**范围**: 将松散的 ledger 事件类型字符串替换为强类型枚举。

**实现**:
1. 在 `packages/hep-autoresearch/src/hep_autoresearch/toolkit/ledger.py`:
   - 定义 `EventType` 枚举 (StrEnum): `workflow_start`, `workflow_end`, `phase_start`, `phase_end`, `approval_request`, `approval_granted`, `approval_denied`, `approval_timeout`, `state_transition`, `error`, `checkpoint`
2. 在 `orchestrator_state.py`:
   - `append_ledger()` 验证 `event_type` 属于枚举，非枚举值拒绝写入 (ValueError)
3. 审查现有代码中所有 `append_ledger()` 调用，确保 event_type 字符串可映射到枚举

**验收**:
- 非枚举 `event_type` 写入时抛出 `ValueError`
- 现有 ledger 事件全部可映射到枚举值

---

## Item 4: H-05 — 跨平台文件锁

**REDESIGN_PLAN 行号**: 搜索 `H-05`

**范围**: 为 Python 侧的共享资源 (ledger, state file, artifacts) 添加文件锁。

**实现**:
1. 先读 `packages/hep-autoresearch/` 中现有的文件写入模式，找到需要加锁的点
2. 实现 `FileLock` 工具类 (或使用 `filelock` 库，如果已在依赖中):
   - 跨平台 (macOS/Linux)
   - 超时机制 (configurable, default 10s)
   - Context manager 支持 (`with FileLock(...):`)
3. 应用到关键写入点:
   - `append_ledger()` — ledger 文件追加
   - `save_state()` — 状态文件写入
   - `write_artifact()` — 产物写入

**验收**:
- 并发写入场景下不丢失数据
- 锁超时时抛出清晰异常

---

## Item 5: H-09 — 幂等性 CAS (Compare-and-Swap)

**REDESIGN_PLAN 行号**: 搜索 `H-09`

**范围**: 状态转换使用 CAS 语义，防止并发竞态。

**实现**:
1. 在 `orchestrator_state.py` 的状态转换方法中:
   - 接受 `expected_state` 参数
   - 读取当前状态，如果 != expected_state，拒绝转换 (CAS failure)
   - 配合 H-05 的文件锁使用
2. 核心 API: `transition_state(run_id, expected_state, new_state) -> bool`
   - 返回 True if successful, raises McpError if state mismatch

**验收**:
- 并发 state transition 请求只有一个成功
- CAS failure 提供清晰的错误信息 (expected vs actual state)

---

## Item 6: NEW-R07 — hep-autoresearch 测试覆盖门禁

**REDESIGN_PLAN 行号**: 搜索 `NEW-R07`

**范围**: CI 门禁确保每个 Python 源文件都有对应测试文件。

**实现**:
1. 创建 `meta/scripts/check_test_coverage_gate.py`:
   - 扫描 `packages/hep-autoresearch/src/hep_autoresearch/` 下所有 `.py` 文件
   - 对每个源文件检查 `packages/hep-autoresearch/tests/` 下是否有对应测试文件 (`test_*.py`)
   - 排除 `__init__.py`, `__main__.py` 等
   - 输出缺失测试的文件列表
   - 非零退出码如果有缺失
2. 在 CI workflow (`ci.yml`) 中添加检查步骤（或在 Makefile 添加 target）
3. 注意: 现有 35% 覆盖率意味着需要一个 baseline whitelist (已存在但未测试的文件可暂时豁免)

**验收**:
- 新增源文件无测试 → CI 失败
- 已有未测试文件通过 whitelist 豁免
- 豁免列表记录在可审计的文件中

---

## 验收

```bash
pnpm -r build     # 0 errors
pnpm -r test      # 所有 TS 测试通过 (expect 702+ tests)
pnpm -r lint      # 0 errors
make test         # 全 monorepo 测试 (TS + Python)
make release      # M-23: 一键构建校验
```

Python 测试:
```bash
cd packages/hep-autoresearch && python -m pytest tests/ -q
```

---

## 双模型收敛审核

实现完成、build + test 通过后：

### 1. 准备审核材料

```bash
# System prompt (同 Batch 2)
cp /tmp/phase2-batch2-system.md /tmp/phase2-batch3-system.md

# Review packet: 写入本批的上下文 + diff
# (格式参照 /tmp/phase2-batch2-r3-packet.md)
```

### 2. 运行 review-swarm

```bash
python3 skills/review-swarm/scripts/bin/run_multi_task.py \
  --out-dir /tmp/phase2-batch3-r1-review \
  --system /tmp/phase2-batch3-system.md \
  --prompt /tmp/phase2-batch3-full-prompt.md
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
2. 根据以下原则分组为下一批 (Batch 4):
   - **主题一致性**: 选择有逻辑关联的 items (如 "schema + codegen", "trace + logging", "pipeline 连通" 等)
   - **LOC 控制**: 总估计 ~500-800 LOC，单 session 可完成
   - **解锁价值**: 优先选择能解锁后续 items 的
   - **语言一致性**: 尽量同一语言 (TS 或 Python)，避免频繁切换
3. 写入 `meta/docs/prompt-phase2-impl-batch4.md`，格式与本文件一致:
   - 更新前置状态 (进度计数、最近 commits)
   - 本批 items 表格 + 解锁关系
   - 各 item 详细实现指导
   - 验收命令
   - 双模型审核指令
   - **包含本段"自续 Prompt 生成"指令**（递归）
4. 告知用户: "下一批 prompt 已写入 `meta/docs/prompt-phase2-impl-batch4.md`，新开对话执行即可。"

### 下一批候选 items (供参考，实际选择需基于执行时的最新状态)

Phase 2 中本批完成后**可能**解锁的项:
- **M-20**: 迁移注册表 (deps: H-15b ✅, H-21 — 本批完成后 ✅)
- **trace-jsonl**: 全链路 JSONL 日志 (deps: H-02 ✅, H-01 ✅, M-14a ✅, H-10 — 本批完成后 ✅)
- **NEW-R05**: 证据抽象层 (deps: NEW-01 ✅, H-18 ✅)
- **NEW-R06**: 分析类型 Schema 整合 (deps: NEW-01 ✅)
- **NEW-R08**: Skills LOC 预算 (deps: NEW-R02a ✅)
- **RT-02**: 工具访问增强 + 溯源 Clean-Room (no deps, high complexity)
- **RT-03**: 统一 Runner 抽象 (no deps, medium)
- **NEW-R14**: hep-mcp 内部包拆分 (deps: NEW-05 ✅, high complexity)
