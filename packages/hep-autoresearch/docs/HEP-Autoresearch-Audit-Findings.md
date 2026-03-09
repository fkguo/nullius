# HEP-Autoresearch 代码审计发现

> 审计日期: 2026-02-10
> 审计范围 (基于 main@0440fc9 的 git 跟踪文件统计): 86 个 `.py` (26,778 行), 14 个 JSON schema (`specs/*.schema.json`), 28 个 eval case (`evals/cases/*`)
> 项目版本: main@0440fc9

---

## 执行摘要 (我是否同意 + 最重要的补充)

总体结论: **基本同意**该审计的优先级方向 (P0/P1/P2 排序合理), 但原文存在若干**路径/统计口径不一致**与**“零集成测试”表述过重**的问题；另外我补充了一个影响线上可用性的关键点: **Web API 对 state/ledger 的写入未加锁且未使用事务式持久化**，与 CLI 并发时可能产生不一致。

我建议的前三个落地动作:
1) **P0** 给 `research_team_config.json` 增加 Schema + preflight 校验 (先最小可用版, 再逐步收紧)。
2) **P1** 把 `orchestrator_cli.py` 的“巨石”拆出可测试边界 (runner/approval/branching/phase-c) 并补齐关键模块单测。
3) **P2** 修 Web API 的并发一致性: 写入持锁 + 使用 `persist_state_with_ledger_event(...)` 保证 ledger/state 顺序与原子性。

## 质量优先原则（可审计 ≠ 全 deterministic）

本审计与修订的目标是 **质量优先 + 可追溯**：能调用 LLM/多 agent 明显提升研究与写作质量的地方，应当使用；不应为了“可审计”把所有步骤都强行 deterministic 从而导致质量下降。

建议边界与约束如下（把 deterministic 用在“底座”，把非确定性用在“内容”）：
- 必须更 deterministic / fail-closed 的部分（底座、不会牺牲质量，且能显著降低事故概率）:
  - 配置与 gates: `research_team_config.json` 的 Schema 校验、未知键/类型错误 fail-closed
  - 运行时一致性: state/ledger 的持锁 + 原子提交（避免并发写入导致 provenance 断裂）
  - eval/CI: 回归用例应尽量离线可重复（避免 live network / 不可控随机导致误报/漏报）
- 允许/鼓励使用 LLM 提升质量的部分（内容层，可非确定性）:
  - 文献综述、literature-gap、method-design、proposal 生成、写作润色/改写、多候选并行与投票/审稿收敛
  - 允许 `temperature>0`、n-best、多 agent，只要输出进入 artifacts 并被后续审查/审批约束
- 对非确定性步骤的“可审计”要求（定义为可复盘/可追责，而非逐字可复现）:
  - 记录 prompts/system、模型/版本、参数、输入上下文（context pack）、输出、关键决策与审批记录
  - 以 artifacts 为 SSOT: `manifest.json` + `summary.json` + `analysis.json` + `run_card`（含 backend/model/argv/env）+ reviewer 输出

如果这条原则要作为长期“项目治理规范”，建议在 `PROJECT_CHARTER.md` / `docs/ARCHITECTURE.md` 增加一条显式引用（避免仅存在于一次性审计文档中而被遗忘/误读）。

## English Summary

Code audit of `hep-autoresearch` at `main@0440fc9`.
- **P0**: Add JSON Schema + preflight validation for `research_team_config.json`.
- **P1**: Split `src/hep_autoresearch/orchestrator_cli.py` into testable modules; strengthen integration-test coverage.
- **P2**: Fix Web API state/ledger consistency (`state_lock` + `persist_state_with_ledger_event`), add MCP retries, unify idempotency.
- **Positives**: No `eval()`/`exec()`/`shell=True`; consistent SSOT triple (manifest/summary/analysis); evidence-first + fail-closed philosophy is visible throughout.

## Dual Review Record (Opus + Gemini)

- `AUDIT-2026-02-10-r1`: `VERDICT: READY`
- `AUDIT-2026-02-10-r2`: `VERDICT: READY`
- `AUDIT-2026-02-10-r3`: `VERDICT: READY`
- `AUDIT-2026-02-10-r4`: `VERDICT: READY` (adds "质量优先原则" section; clarifies auditability vs determinism)
- `AUDIT-2026-02-10-r5` (final): `VERDICT: READY` (final polish: Issue #15 concurrency caveat + record pointers)

Reviewer outputs (repo-root-relative):
- `artifacts/runs/AUDIT-2026-02-10-r5/dual_review/agent_swarm/claude_output.md`
- `artifacts/runs/AUDIT-2026-02-10-r5/dual_review/agent_swarm/gemini_output.md`

统计口径 (可复现):
- `.py` 文件数/行数: `git ls-files '*.py' | wc -l` + `git ls-files -z '*.py' | xargs -0 wc -l | tail -n 1`
- schema 数: `ls specs/*.schema.json | wc -l`
- eval case 数: `find evals/cases -maxdepth 1 -mindepth 1 -type d | wc -l`

## 优先级矩阵

(注: Issue 编号沿用原审计记录并插入补充项 Issue #15，因此不保证严格连续。)

| # | 问题 | 风险 | 工作量 | 优先级 |
|---|------|------|--------|--------|
| 2 | config 无 schema 校验 | 高 (静默错误) | **低 (2-3天)** | **P0 立即** |
| 1 | orchestrator_cli.py 巨石 | 高 (可维护性) | 高 (2-3周) | **P1 下一周期** |
| 3 | 集成测试覆盖不足 (非“零”) | 高 (质量) | 高 (2-3周) | **P1 下一周期** |
| 4 | 核心模块缺单测 | 中高 | 中 (1周) | **P1** |
| 5 | Phase C 缺 eval case | 中 | 低 (2-3天) | **P2** |
| 6 | Web API 覆盖不足 | 中 (远程控制) | 中 (1周) | **P2** |
| 15 | Web API 写 state/ledger 未加锁 | 中 (一致性/恢复) | 低-中 (2-5天) | **P2** |
| 7 | MCP 客户端无重试 | 中 | 低 (2-3天) | **P2** |
| 9 | 幂等性不统一 | 中 (数据安全) | 低 (2-3天) | **P2** |
| 8 | 状态机 Windows/并发 | 中 | 中 (1周) | **P3** |
| 10 | schema 状态不明 | 低 | 低 (1天) | **P3** |
| 11-14 | 细节级 (TODO/timeout/registry/KB perf) | 低 | 低 | **P4** |

---

## 整改追踪（进度记录）

该表用于记录“按审计建议实施修改”的实际进度（以 repo 内 artifacts+diff 为证据）。

| Issue | 状态 | 实施标签 | 说明 |
|---|---|---|---|
| #2 config schema | planned | (pending) | `research_team_config.json` → schema + 校验 + 测试 |
| #15 Web state/ledger locking | planned | (pending) | Web 写入路径持锁 + 事务式落盘 + 回归测试 |
| #7 MCP retry | planned | (pending) | stdio client 重试/退避/重连与测试 |
| #9 idempotency | planned | (pending) | reproduce/revision 默认拒绝覆盖 + `--force` |
| #5 Phase C eval cases | planned | (pending) | E34–E38 补齐（基于现有确定性 run artifacts） |

---

## P0: 关键 — 立即修复

### Issue #2: `research_team_config.json` 无 Schema 校验

- **文件**: `research_team_config.json` (约 362 行; 项目根目录)
- **背景**: 该文件被 `research-team` 工作流脚本作为项目级配置读取 (例如 preflight / 组队循环的 gates/allowlist/profile 等)。
- **问题**: 100+ 配置键, 当前缺少强制的 JSON Schema 校验与加载时类型检查
  - 拼写错误 / 键名漂移 → 行为偏离但难以定位 (常表现为 gate 没生效、allowlist 无效、某些阶段被跳过/误触发)
  - 类型错误 (string vs int/bool/array) → 可能在运行时以非直观方式暴露 (崩溃或静默采用默认值)
  - 缺少必填字段 / 结构不一致 → 未定义行为 (尤其是与 preflight gate 相关的配置)
- **对比**: 其他配置已有 schema (`plan.schema.json`, `run_card_v2.schema.json`)
- **建议**:
  - 创建 `specs/research_team_config.schema.json` (先覆盖顶层结构 + 高风险键; `additionalProperties: true` 起步, 逐步收紧到 forbid 拼写错误)
  - 在 preflight 阶段强制校验 (失败即 fail-closed), 并输出“最小修复建议”(缺字段/类型错误/未知键列表)
  - 工作量估计建议拆两档: (i) 最小 schema + preflight 校验: 2-3 天; (ii) 全量 strict schema (unknown keys=fail): 可能 1-2 周 (取决于键数量与向后兼容策略)

---

## P1: 高优先级

### Issue #1: orchestrator_cli.py 巨石文件 (5,115 行)

- **文件**: `src/hep_autoresearch/orchestrator_cli.py`
- **问题**: 单文件 81 个函数定义, 0 个类
  - `cmd_run()` ~1,000 行 (workflow dispatch + gate precheck + context build + artifact write)
  - `cmd_literature_gap()` ~565 行 (Phase C1 内联)
  - `main()` ~457 行 (argparse + dispatch)
  - `cmd_bridge()` ~370 行 (MCP bridging 内联)
  - `_cmd_branch_add_locked()` ~239 行 (分支管理内联)
- **影响**: 难以隔离测试, 合并冲突率高, 阻碍并行开发
- **建议拆分为**:
  - `orchestrator_runner.py` — 从 `cmd_run()` 提取: workflow dispatch + gate precheck
  - `orchestrator_approval.py` — request/approve/reject
  - `orchestrator_branching.py` — branch list/add/switch
  - `orchestrator_phase_c.py` — bridge + literature-gap + method-design

### Issue #3: 集成测试覆盖不足 (非“零”)

**更正**: 当前并非“零集成测试”。例如 `tests/test_paper_reviser_workflow.py` 是离线 E2E 流程测试 (含 gate + resume/skip 逻辑)，但整体仍缺少覆盖“全链路/失败恢复/并发一致性”的系统集成测试矩阵。

- **目录**: `tests/` (14 个 `.py`, 约 2,769 行; 其中 `test_*.py` 为 13 个)
- **问题**: 集成/回归测试覆盖不足 (存在 workflow 级别覆盖，但缺少端到端与 CI 一体化)
  - 无 ingest→reproduce→revision 完整流水线测试
  - 无 init→start→run→approve→resume 生命周期测试
  - 无 CLI + Web API 并发状态同步/一致性测试
  - 无失败恢复路径测试
  - 28 个 eval case 为手动执行, 未集成到 CI
- **建议**: 添加“集成测试套件 + eval/CI 串联”，覆盖完整工作流 + 生命周期 + 并发访问 + 失败恢复

### Issue #4: 核心模块缺单测

| 模块 | 行数 | 重要性 | 当前覆盖 |
|------|------|--------|----------|
| `orchestrator_state.py` | 699 | 状态机核心 | 无单测 |
| `run_card_schema.py` | 654 | run_card v2 校验 | 无单测 |
| `ingest.py` | 928 | ingest workflow | 仅 eval E1/E2 |
| `reproduce.py` | 299 | reproduce workflow | 仅 eval E4 |
| `revision.py` | 333 | revision legacy workflow | 仅 eval E5 |
| `mcp_stdio_client.py` | 335 | MCP 通信 | 无单测 |
| `adapters/registry.py` | 70 | 适配器路由 | 无单测 |
| `context_pack.py` | 337 | 上下文打包 | 仅 eval E11 |
| `project_scaffold.py` | 375 | hepar init 脚手架 | 仅 eval E30 |

- 另外: `test_kb_profile.py` 仅 35 行, 覆盖极薄
- **建议**: 为所有关键模块添加单测, 重点是状态机和 MCP 客户端

---

## P2: 中高优先级

### Issue #5: Phase C 工作流缺少 Eval Case

| 功能 | 单元测试? | Eval Case? | 状态 |
|------|-----------|-----------|------|
| `literature-gap` (Phase C1) | 有 (288 行) | **无** | 缺口 |
| `method-design` (Phase C2) | 有 (367 行) | **无** | 缺口 |
| `doctor` (MCP 诊断) | 有 (170 行) | **无** | 缺口 |
| `bridge` (MCP bridge) | 有 (170 行) | **无** | 缺口 |
| `run-card validate/render` | 无 | **无** | 缺口 |
| E33 (paper_reviser) | — | 有但仅检查文件存在 | 未执行实际工作流 |

- **建议**: 创建 eval case E34-E38, 覆盖 Phase C 工作流 + bridge + run-card + doctor

### Issue #6: Web API 仅覆盖 36% CLI 命令 (9/25)

- **文件**: `src/hep_autoresearch/web/app.py` (345 行)
- **问题**: 16 个 CLI 命令缺少 REST 端点
  - 无 `POST /start` — 无法远程启动运行
  - 无 `POST /run` — 无法远程执行工作流 **(最关键)**
  - 无 `POST /checkpoint` — 无法远程心跳
  - 无 `GET /context` — 无法远程获取上下文
  - 无 `POST /branch/*` — 无法远程管理分支
  - 无 `POST /literature-gap` — 无法远程触发 Phase C
  - 无 `POST /method-design` — 无法远程触发方法设计
  - 无 `GET /doctor` — 无法远程诊断
- **建议**: 实现缺失的 REST 端点

### Issue #15: Web API 对 state/ledger 的写入未加锁且非事务式

- **文件**: `src/hep_autoresearch/web/app.py`
- **问题**:
  - Web 端点在写 `state.json` / 追加 `ledger.jsonl` 时**未使用** `state_lock(repo_root)`，与 CLI 并发时可能发生竞态
  - Web 写入未使用 `persist_state_with_ledger_event(...)` (定义于 `src/hep_autoresearch/toolkit/orchestrator_state.py`; 该函数提供 ledger/state 顺序与原子提交的“transaction-ish”保障)
  - 一旦出现 ledger 写失败/部分写入，恢复路径更依赖人工排查 (与 evidence-first 的可审计目标相冲突)
- **建议**:
  - 所有会修改 state/ledger 的端点统一包裹 `with state_lock(repo_root): ...`
  - 尽量改为 `persist_state_with_ledger_event(...)` (定义于 `src/hep_autoresearch/toolkit/orchestrator_state.py`) 写入 (或提供同等语义的封装)，并补一个并发/恢复测试用例
  - 另见 Issue #8 (跨平台锁 + schema 版本管理): Windows 环境会进一步放大本 Issue 的影响范围
  - ⚠️ 在修复前：不要并发使用 Web API 与 CLI 对同一 `repo_root` 做写操作（approve/pause/resume/init 等），避免 provenance 断裂/丢事件

### Issue #7: MCP 客户端无重试机制

- **文件**: `src/hep_autoresearch/toolkit/mcp_stdio_client.py` (335 行)
- **问题**:
  - 已有: timeout + graceful shutdown
  - **缺失**: 重试逻辑 (连接错误时立即失败)
  - **缺失**: 指数退避
  - **缺失**: 断连后重连
  - **缺失**: 健康检查 / keepalive
  - 调用方必须自行实现重试
- **建议**: 添加带指数退避的重试逻辑 + keepalive 机制

### Issue #9: 幂等性不统一

| 工作流 | 重复执行行为 | 安全? |
|--------|-------------|-------|
| ingest | 检查 notes 是否存在, 默认不覆盖 | 安全 |
| reproduce | **无检查, 直接覆盖** | **不安全** |
| paper_reviser | 检查 round_01 是否存在, 需要 `--force` | 安全 |
| method_design | 抛出 `FileExistsError` | 安全 |
| computation | 支持 `--resume` 跳过已完成阶段 | 安全 |
| revision | **无检查, 直接覆盖** | **不安全** |

- **建议**: 统一策略: "存在则拒绝 + `--force` 覆盖"

---

## P3: 中等优先级

### Issue #8: 状态机并发和 Windows 兼容性

- **文件**: `src/hep_autoresearch/toolkit/orchestrator_state.py` (699 行)
- **问题**:
  - 使用 `fcntl.flock()` (POSIX advisory lock)
  - **Windows**: 降级为 NO-OP (`except ImportError: yield`) — 完全无保护
  - Web `/status` 端点无锁读取 → POSIX 下由于 `os.replace` 原子替换 torn write 风险较低，但在 Windows/跨进程场景中仍可能出现一致性问题
  - 无 schema 版本迁移路径 (未来 schema 变更将破坏旧运行)
- **建议**: 实现跨平台锁 + schema 版本管理

### Issue #10: 两个 Schema 状态不明

| Schema | 行数 | 问题 |
|--------|------|------|
| `reviewer_summary.schema.json` | 63 | **代码中未找到使用** |
| `run_card.schema.json` | 63 | 可能为 v1 遗留 (v2 已替代) |

- **建议**: 明确意图, 标记为 deprecated 或删除

---

## P4: 低优先级 (打磨)

### Issue #11: 残留 TODO 标记

- **文件**: `src/hep_autoresearch/toolkit/evolution_proposal.py:462`
- **内容**: `"description": "TODO: turn one proposal into a deterministic eval case (no live network)."`
- **建议**: 实现或转为文档化的已知限制

### Issue #12: 硬编码超时值

| 位置 | 值 | 建议 |
|------|---|------|
| `src/hep_autoresearch/toolkit/_http.py` | `timeout_seconds=60.0` / `120.0` | 提取到配置常量 |
| `src/hep_autoresearch/toolkit/computation.py` | `default_timeout_seconds=900` | 提取到 run_card 参数 |
| `src/hep_autoresearch/toolkit/mcp_stdio_client.py` | `startup_timeout_seconds=8.0` | 提取到配置 |

### Issue #13: 适配器注册为手动维护

- **文件**: `src/hep_autoresearch/toolkit/adapters/registry.py` (70 行)
- **问题**: 使用 if-else 链进行适配器注册, 无自动发现. 添加新适配器需修改 2 个函数 + 1 个 set.
- **建议**: 引入基于装饰器的注册机制

### Issue #14: KB 性能隐患

- **文件**: `src/hep_autoresearch/toolkit/kb_index.py`
- **问题**: 对每个文件计算 SHA256 (O(n × file_size)). 当前 ~25 篇论文可接受, 但 1000+ 篇时将成为瓶颈.
- **建议**: 添加基于 mtime 的缓存

---

## 正面发现

- **安全态势**: 优秀 — 未发现 `eval()`, `exec()`, `shell=True`, `os.system()`
- **工作流模式一致性**: 全部遵循 `*_one(Inputs, repo_root)` + SSOT 三件套 (manifest.json + summary.json + analysis.json)
- **无循环导入**
- **无严重错误吞咽模式**
- **核心设计哲学** (evidence-first, fail-closed, auditable) 在代码库中一致体现
