# Nullius 生态圈开发规范 (Ecosystem Development Contract)

> **版本**: 1.3.0-draft (R2: +SEC-03/SYNC-05/REL-01, CI upgrade path, M-19 severity; R3: SEC-03 staged fail-closed, +GATE-05/REL-02, SYNC-02 determinism; R5: +CODE-01 模块化与反模式强制, CI 脚本修正 + diff-scoped 分阶段执行; R6: CFG-01 修正 HEP_DATA_DIR 默认值, +CODE-01 治理提案 AMEND-01; R7: LOG-03 开放词表+格式守卫, REL-01 对齐 make release 检查清单, SYNC-02 确定性清单, PLUG-01 允许叶子包 @nullius/shared, LANG-01 `_zh` 后缀约定)
> **日期**: 2026-10-17
> **适用范围**: hep-mcp, idea-engine, orchestrator, project-contracts, skills/, skills-market, meta/
> **强制级别**: 所有新增/修改代码必须遵守；存量代码按当前 checked-in 架构/治理文档分阶段对齐
> **违规默认行为**: **fail-closed**（除非规则明确标注 fail-open）

## 总则

1. 本规范定义 15 个域的强制约束，防止增量开发引入新的跨组件不一致
2. 每条规则附 CI/lint 可执行的验证方式
3. 违规时的失败行为明确标注为 `fail-closed`（阻断 CI/运行）或 `fail-open`（警告但不阻断）
4. 规则编号格式: `{域缩写}-{序号}`，如 `ERR-01`
5. **语言规范**: 所有源代码（含注释、commit message、PR description）使用英文；用户手册提供英文版为 canonical source，中文版作为翻译产物在功能完工后生成

---

## 1. 错误处理 (ERR)

### ERR-01: 统一错误信封

**规则**: 所有跨组件边界的错误响应必须包含以下字段：

```json
{
  "domain": "string (组件名: hep-mcp | idea-engine | orchestrator | skill)",
  "code": "string (错误码)",
  "message": "string (人类可读)",
  "retryable": "boolean",
  "run_id": "string | null (仅拥有 run 的组件)",
  "trace_id": "string (UUID v4)",
  "data": "object | null (附加上下文)"
}
```

`run_id` 只属于拥有 run 的组件（orchestrator 等）。不拥有 run 的 provider 包（hep-mcp 及其他 `*-mcp` 包）没有 run 可报，其错误信封不带 `run_id` 字段。

**CI 验证**:
```bash
# lint: 检查所有 throw/raise 语句是否使用 NulliusError 工厂
grep -rn 'throw new Error\|raise Exception' --include='*.ts' --include='*.py' \
  | grep -v 'node_modules\|__pycache__\|test' \
  | grep -v 'NulliusError\|McpError\|RpcError' && exit 1 || exit 0
```

**违规行为**: **fail-closed** — 裸 `throw new Error()` 或 `raise Exception()` 阻断 CI

> **CI 升级路径**: 当前 grep 检查为 Phase 0/1 临时实现。Phase 3 升级为 AST-based lint（TS: ESLint custom rule; Python: `ast` 模块），消除注释/字符串中的误报。

### ERR-02: retryable 标记强制

**规则**: 所有错误码必须在错误码注册表中声明 `retryable` 默认值：

| 错误码 | retryable | 说明 |
|---|---|---|
| `RATE_LIMIT` | `true` | 必须附带 `retry_after_ms` |
| `UPSTREAM_ERROR` | `true` | 外部服务暂时不可用 |
| `INVALID_PARAMS` | `false` | 参数错误，重试无意义 |
| `NOT_FOUND` | `false` | 资源不存在 |
| `INTERNAL_ERROR` | `false` | 内部异常 |
| `UNSAFE_FS` | `false` | 安全违规 |

**CI 验证**:
```bash
# 当前没有独立的 repo-local 错误码注册表 checker。
# 先由 package-local contract tests 覆盖错误码 / retryability truth。
pnpm --filter @nullius/hep-mcp test -- tests/toolContracts.test.ts
```

**违规行为**: **fail-closed** — 未注册的错误码阻断 CI

### ERR-03: McpStdioClient 错误码保留

**规则**: Python 侧 `McpStdioClient.call_tool_json()` 返回值必须包含原始 `error_code` 字段，不得丢弃 MCP 错误码。

**CI 验证**:
```bash
# 契约测试: 模拟 MCP 错误响应 → 验证 result.error_code 被保留
pnpm --filter @nullius/orchestrator test -- tests/orchestrator-mcp-tools-spec.test.ts
```

**违规行为**: **fail-closed** — 错误码丢失导致调用方无法区分可重试/不可重试错误

### ERR-04: run 上下文中的错误必须带 run_id

**规则**: 拥有 run 的组件中，错误发生在 run 上下文时，`run_id` 必须填充实际值；仅在无 run 上下文时允许 `null`。不拥有 run 的 provider 包（如 hep-mcp）的错误信封不带此字段（见 ERR-01）。

**CI 验证**:
```bash
# 当前没有独立的 repo-local run_id 错误信封 checker。
# 至少保持 orchestrator package 的 run-state / CLI tests 通过。
pnpm --filter @nullius/orchestrator test -- tests/nullius-cli.test.ts
```

**违规行为**: **fail-open** (警告) — 存量代码渐进修复，新代码强制

---

## 2. ID 与引用 (ID)

### ID-01: Prefixed ID 格式

**规则**: 所有新组件的实体 ID 必须使用 Stripe 风格前缀格式：`{prefix}_{uuid}`

| 实体类型 | 前缀 | 示例 |
|---|---|---|
| Project | `proj_` | `proj_550e8400-e29b-41d4-a716-446655440000` |
| Run | `run_` | `run_a1b2c3d4-...` |
| Campaign | `camp_` | `camp_...` |
| Node | `node_` | `node_...` |
| Approval | `appr_` | `appr_A1-0042` (保留现有格式，加前缀) |

**CI 验证**:
```bash
# 当前没有独立的 repo-local prefixed-id lint。
# 先由 owning package tests + review fail-closed 保持该约束。
```

**违规行为**: **fail-open** (警告) — 旧 ID 通过映射表互操作，新 ID 强制前缀

### ID-02: 跨组件引用模型

**规则**: 跨组件传递实体引用时，必须使用结构化引用而非裸 ID：

```json
{
  "component": "hep-mcp | idea-engine | orchestrator",
  "kind": "project | run | campaign | node | artifact",
  "id": "prefixed_uuid"
}
```

**CI 验证**:
```bash
# 当前没有独立的 repo-local cross-reference validator。
# 先由跨组件 contract tests 和 schema consumers 覆盖该约束。
```

**违规行为**: **fail-open** (警告) — 渐进迁移

### ID-03: ArtifactRef V1 强制

**规则**: 所有跨组件 artifact 指针必须使用 `ArtifactRefV1`：

```json
{
  "uri": "rep://runs/{run_id}/artifact/{artifact_path}",
  "kind": "section_draft | token_budget | ...",
  "schema_version": 1,
  "sha256": "hex string",
  "size_bytes": 12345,
  "produced_by": "tool_name@version",
  "created_at": "ISO 8601 UTC Z"
}
```

**CI 验证**:
```bash
# 当前没有独立的 repo-local ArtifactRef validator。
# 至少保持 artifact / URI authority 相关 contract tests 通过。
pnpm --filter @nullius/shared test -- src/__tests__/artifact-ref.test.ts
```

**违规行为**: **fail-closed** — 缺少完整性字段的 artifact 引用阻断 CI

---

## 3. 契约同步 (SYNC)

### SYNC-01: Schema 快照 SHA256 门禁

**规则**: `idea-engine/contracts/idea-runtime-contracts/` 中的 package-local schema snapshot 是当前 runtime-default authority。

**CI 验证**:
```bash
# runtime-default authority must stay package-local to idea-engine
pnpm --filter @nullius/idea-engine test -- tests/runtime-asset-authority.test.ts
```

**违规行为**: **fail-closed** — 指纹不匹配阻断 CI 和 commit

### SYNC-02: 工具清单自动生成

**规则**: `packages/hep-mcp/tool_catalog.{standard,full}.json` 由 `pnpm --filter @nullius/hep-mcp catalog` 从运行时注册表 `getTools(mode)` 生成（`src/tools/utils/toolCatalog.ts` 的 `buildToolCatalog()`），禁止手动编辑。文件只含确定性字段（`mode`、`count`、按名排序的 `tools`），不含时间戳或 commit；生成时固定 `HEP_ENABLE_ZOTERO=1`（完整清单）。清单变化只能来自注册表变化，并在 PR diff 中显形。

**CI 验证**:
```bash
# 测试在内存中重算清单并与入库 JSON 逐字节比对（随 pnpm -r test 运行）
pnpm --filter @nullius/hep-mcp test -- tests/contracts/toolCatalog.test.ts
# 本地等价：重生成后无 diff
pnpm --filter @nullius/hep-mcp catalog && git diff --exit-code packages/hep-mcp/tool_catalog.standard.json packages/hep-mcp/tool_catalog.full.json
```

**违规行为**: **fail-closed** — 清单与运行时 `getTools()` 不一致阻断 CI

### SYNC-03: 工具名常量化

**规则**: MCP 工具调用必须使用对应包内的注册表/常量来源，禁止在 workflow 层复制裸字符串清单。

**CI 验证**:
```bash
# lint: 检查 call_tool_json() 调用是否使用常量
pnpm --filter @nullius/hep-mcp test -- tests/docs/docToolDrift.test.ts
```

**违规行为**: **fail-closed** — 裸字符串工具名阻断 CI

> **CI 升级路径**: 当前 grep 检查为临时实现。Phase 3 升级为 AST-based lint，精确匹配 `call_tool_json()` 调用参数。

### SYNC-04: 运行时兼容性握手

**规则**: 已删除的 legacy shell wrapper（如已退役的 Python doctor surface）不再是 live 握手 authority。当前运行时兼容性握手必须由 lower-level MCP contract / tool inventory 验证承担，至少覆盖 `initialize → hep_health / tool contracts → tools/list` 这一条链路。

**CI 验证**:
```bash
# lower-level MCP contract + inventory verification
pnpm --filter @nullius/hep-mcp test -- tests/toolContracts.test.ts
pnpm --filter @nullius/hep-mcp docs:tool-counts:check
```

**违规行为**: **fail-open** (警告 + 降级运行) — hash 不匹配时警告但允许继续（避免升级死锁）

### SYNC-05: 跨组件冒烟矩阵

**规则**: CI 必须覆盖 `standard` 和 `full` 两种 MCP tool inventory truth，但不再依赖已经删除的 `doctor` / `bridge` parser shells。当前 smoke 必须走 package-local contract/tool-listing 验证，而不是复活已退役 wrapper。

**CI 验证**:
```bash
# standard/full tool inventory + contract verification
pnpm --filter @nullius/hep-mcp docs:tool-counts:check
pnpm --filter @nullius/hep-mcp test -- tests/tools.test.ts tests/toolContracts.test.ts
```

**违规行为**: **fail-closed** — 冒烟测试失败阻断 CI

### SYNC-06: 跨语言类型代码生成门禁

**规则**: `meta/schemas/` 下的 JSON Schema 为所有跨语言共享类型的唯一 SSOT。TS 接口（`json-schema-to-typescript`）和 Python 生成模型 / bindings（`datamodel-code-generator`，当前输出为 `meta/generated/python/` 下的 Pydantic v2 artifacts）必须由 CI 自动生成。禁止手写跨语言镜像类型。

**CI 验证**:
```bash
make codegen-check  # 重新生成 → git diff --exit-code */generated/
```

**违规行为**: **fail-closed** — 生成代码与 committed 不一致阻断 CI

### SYNC-07: 新技能接线同步（验收项）

**规则**: 新增或实质改版一个 `skills/` 技能时，同一变更（或其收口 lane）必须同步检查并更新使用侧接线，不得只落技能本体。最低清单：

1. `skills/research-harness/SKILL.md` 的按结果类型分派表与 Fold Results Back 节 —— 若新技能承担某类结果的验证或产出职责，分派表必须能路由到它；
2. `packages/project-contracts/src/project_contracts/scaffold_templates/` 中面向项目的常驻文本（事件→工作流对照表等）—— 若技能应在某个工作时刻被默认想起；
3. `packages/skills-market/` 目录条目与 `depends_on`（含 `generate_manifest_components.py --write` 再生成）；
4. 相关邻居技能的 "Routing to Neighbor Skills" / 组合说明。

背景：多个真实项目审计显示，技能落地后若无任何常驻文本引用，它对代理实际不存在（"孤儿技能"）；该漂移是结构性的，必须由验收项拦住。

**CI 验证**: 人工 review 验收项 + `packages/skills-market` 校验测试（依赖目标存在性）；分派表已落地；常驻文本↔技能清单的自动一致性锁仍待补充。

**违规行为**: **fail-open（review 阻断）** —— reviewer 在 PR/lane 收口时核对本清单；缺接线的新技能不得标记为已交付。

## 4. 配置 (CFG)

### CFG-01: 配置键注册表

**规则**: 所有环境变量/配置键必须在 `meta/docs/ecosystem_config_v1.md` 中注册，包含：键名、类型、默认值、优先级链、所属组件。

| 键 | 类型 | 默认值 | 优先级 | 组件 |
|---|---|---|---|---|
| `HEP_DATA_DIR` | path | `~/.nullius/hep-mcp` | env > .env > default | hep-mcp |
| `HEP_TOOL_MODE` | enum | `standard` | env > .env > default | hep-mcp |
| `HEP_ENABLE_ZOTERO` | bool | `true` | env > .env > default | hep-mcp |
| `HEP_BUDGET_INSPIRE_SEARCH_PAGE_SIZE` | int | `1000` | tool arg > env > .env > default | hep-mcp |
| `HEP_BUDGET_INSPIRE_SEARCH_MAX_RESULTS` | int | `10000` | tool arg > env > .env > default | hep-mcp |
| `HEP_BUDGET_CONCURRENCY` | int | `4` | tool arg > env > .env > default | hep-mcp |
| `PDG_DB_PATH` | path | (必需) | env > .env | pdg-mcp |
| `PDG_ARTIFACT_TTL_HOURS` | int | `24` | env > .env > default | pdg-mcp |
| `ZOTERO_BASE_URL` | URL | `http://127.0.0.1:23119` | env > .env > default | zotero-mcp |

**CI 验证**:
```bash
# 当前没有自动检查未注册配置键的 linter 或测试。
# 新增配置键须登记在上表，评审时核对。
```

**违规行为**: 评审中发现的未登记配置键应在合入前登记或删除

### CFG-02: .env 加载一致性

**规则**: 所有组件入口必须尝试加载 CWD `.env` 文件（`override: false`，即不覆盖已设置的环境变量）。

**CI 验证**:
```bash
# 当前没有独立的 repo-local .env integration test。
# 至少保持 package-local tool inventory truth 通过。
pnpm --filter @nullius/hep-mcp docs:tool-counts:check
```

**违规行为**: **fail-closed** — 配置不一致导致"shell 中正常，编排器中失败"

### CFG-03: 环境变量传播白名单

**规则**: MCP subprocess launchers must keep a strict ambient baseline, isolate `HOME`, separate explicit non-secret configuration from generic named credentials, reject loader/shell injection keys and authenticated ambient proxies, fail before spawn for declared missing credentials, terminate the owned process tree on initialization failure, unexpected parent exit, timeout, and close, and bound reconnects across the client lifetime. 新增配置键时必须同步更新 registry、help 与边界测试。

**CI 验证**:
```bash
pnpm --filter @nullius/orchestrator exec vitest run tests/mcp-client-process.test.ts tests/workflow-runtime.test.ts
```

**违规行为**: **fail-closed** — 配置键未传播阻断 CI

### CFG-04: 配置回显

**规则**: 已删除的 Python doctor wrapper 不再承担配置回显 authority。当前配置可观测性必须由 lower-level diagnostics / contract tests 承担，至少保证与 `hep_health`、tool contracts、tool inventory 相关的关键配置不会退化成静默黑箱。

**CI 验证**:
```bash
# lower-level diagnostics / contract verification
pnpm --filter @nullius/hep-mcp test -- tests/toolContracts.test.ts
```

**违规行为**: **fail-open** (警告) — 缺少回显不阻断但降低可调试性

---

## 5. Gate (GATE)

### GATE-01: Gate 注册表强制

**规则**: 所有 gate 必须在 `GateRegistry` 中注册。run_card `phases[].gates` 仅接受已注册的 gate ID。

**已注册 Gate**:

| Gate ID | 类型 | 作用域 | fail_behavior |
|---|---|---|---|
| `A1` | approval | mass_search | fail-closed |
| `A2` | approval | code_changes | fail-closed |
| `A3` | approval | compute_runs | fail-closed |
| `A4` | approval | paper_edits | fail-closed |
| `A5` | approval | final_conclusions | fail-closed |
| `quality_compile` | quality | paper_compile | fail-closed |
| `quality_originality` | quality | evidence_grounding | fail-closed |
| `delegation_budget` | quality | delegated_workstreams | fail-closed |
| `team_convergence` | convergence | research_team | fail-closed |
| `draft_convergence` | convergence | draft_review | fail-closed |

**CI 验证**:
```bash
# Gate registry entries, types, uniqueness, and fail-closed policy.
pnpm --filter @nullius/shared test -- --run src/__tests__/gate-registry.test.ts
```

**违规行为**: **fail-closed** — 未注册 gate 在编译期（run_card 验证）即报错，不等到运行期

### GATE-02: GateSpec 通用抽象

**规则**: 所有组件的 gate 概念必须可映射到 `GateSpec v1`：

```json
{
  "gate_id": "string",
  "gate_type": "approval | quality | convergence",
  "scope": "string (作用域描述)",
  "policy": "object (策略参数)",
  "fail_behavior": "fail-open | fail-closed",
  "audit_required": true
}
```

**CI 验证**:
```bash
# schema codegen / generated artifacts must stay in sync with checked-in schemas
make codegen-check
```

**违规行为**: **fail-closed** — 不符合 GateSpec 的 gate 定义阻断 CI

### GATE-03: 审批超时执行闭环

**规则**: 审批 watchdog 必须在 `status`/`run`/`approve` 路径统一检查 `timeout_at`。超时后根据 `on_timeout` 策略执行状态迁移并写入 ledger 事件。`on_timeout` 枚举: `block`(默认) | `reject` | `escalate`。

**CI 验证**:
```bash
# 单元测试: 设置过期 timeout_at → 验证 watchdog 触发
pnpm --filter @nullius/orchestrator test -- tests/nullius-cli.test.ts
```

**违规行为**: **fail-closed** — 超时未执行策略视为治理绕过

### GATE-04: 审批预算强制

**规则**: 审批策略中声明的预算限制必须在运行时强制检查，不得仅作为展示字段。

**CI 验证**:
```bash
# 当前审批预算 coverage 保持在 package-local approval packet tests 内。
pnpm --filter @nullius/orchestrator test -- tests/nullius-cli.test.ts
```

**违规行为**: **fail-closed** — 预算绕过视为治理失效

### GATE-05: 审批三件套产物强制 (R3 新增)

**规则**: 每次审批请求必须同时生成三份产物：`packet_short.md`（≤1 页摘要）、`packet.md`（全量细节）、`approval_packet_v1.json`（结构化，符合 `approval_packet_v1.schema.json`）。缺少任一产物视为审批请求不完整。

**CI 验证**:
```bash
# 集成测试: 触发审批 → 验证审批产物存在且结构通过 package-local checks
pnpm --filter @nullius/orchestrator test -- tests/nullius-cli.test.ts
```

**违规行为**: **fail-closed** — 不完整的审批产物阻断审批流程

---

## 6. 日志 (LOG)

### LOG-01: 结构化 JSONL 格式

**规则**: 所有组件的机器可解析日志必须输出为 JSONL 格式：

```json
{"ts": "ISO8601Z", "level": "debug|info|warn|error", "component": "string", "trace_id": "uuid", "event": "string", "data": {}}
```

人类可读 CLI 输出可保留，但必须同时输出 JSONL 流（到 stderr 或日志文件）。

**CI 验证**:
```bash
# 检查 computation 入口的日志输出可被 jq 解析
nullius run --workflow-id computation --dry-run 2>&1 | grep '^{' | jq -e '.ts and .level and .component' > /dev/null
```

**违规行为**: **fail-open** (警告) — 渐进迁移，新组件强制

### LOG-02: trace_id 全链路透传

**规则**: 每次 MCP tool call 必须携带 `trace_id` (UUID v4)。`trace_id` 必须贯穿 MCP → orchestrator → ledger → 日志。

**CI 验证**:
```bash
# 跨组件 trace_id 透传至少要由 package-local logging/boundary tests 覆盖。
pnpm --filter @nullius/orchestrator test -- tests/nullius-cli.test.ts
pnpm --filter @nullius/hep-mcp test -- tests/docs/docToolDrift.test.ts
```

**违规行为**: **fail-open** (警告) — 缺少 trace_id 不阻断但降低可观测性

### LOG-03: Ledger 事件类型

**规则**: `.nullius/ledger.jsonl` 是追加式历史，由 `StateManager.appendLedger()` / `saveStateWithLedger()` / `transitionStatus()`（`packages/orchestrator/src/state-manager.ts`）写入。`event_type` 是开放词表，不设封闭枚举，但必须满足：

1. 非空、形如 `^[a-z][a-z0-9_]*$` 的标识符（`assertLedgerEventType()` 在写入前校验）；`transitionStatus()` 在调用方未给名时写 `status_<run_status>`。
2. 运行状态只能由读模型 `deriveLedgerStatusFromOperatorEvent()`（`packages/orchestrator/src/operator-read-model-summary.ts`）识别的事件名推导；未识别的事件保持前一状态，并由 `orch_run_list` 以 `LEDGER_EVENT_UNMAPPED` 报告，不得静默丢弃。
3. 新增会影响运行状态推导、或被其他包（如 `project-mcp`）读取的事件名，必须同时加入上述读模型映射及其测试。

**CI 验证**:
```bash
# 格式守卫 + 事件名断言 + 未映射事件报告
pnpm --filter @nullius/orchestrator test -- tests/orchestrator.test.ts tests/orch-fleet-status.test.ts
```

**违规行为**: **fail-closed** — 空的或不合格式的 `event_type` 在写入时抛错；读模型未识别的事件名以 `LEDGER_EVENT_UNMAPPED` 报告但不阻断

### LOG-04: 日志脱敏

**规则**: 日志禁止明文记录 API Key、凭据、隐私数据。所有日志输出必须经过 redaction 层。

**敏感模式**:
```
API Key:     sk-[a-zA-Z0-9]{20,}
Bearer:      Bearer [a-zA-Z0-9._-]+
路径中的用户名: /Users/[^/]+/ → /Users/<redacted>/
```

**CI 验证**:
```bash
# 契约测试: JSONL 日志输出必须脱敏敏感参数
pnpm --filter @nullius/hep-mcp test -- tests/contracts/jsonlStderrLogging.test.ts
```

**违规行为**: **fail-closed** — 日志含 secrets 模式阻断 CI

---

## 7. Artifact (ART)

### ART-01: 命名规范

**适用范围**: 控制面写入 run 目录（`<project_root>/artifacts/runs/<run_id>/`）、且其格式由 `meta/schemas/` 定义的契约型 artifact。provider 工具写入调用方 `output_dir` 的研究输出不在此列：它们用各工具文档写明的固定名或调用方给定的名字（如 `inspire_search_export_<hash>.jsonl`、`zotero_map_v1.json`、`external_api/` 下的请求/响应记录）。其中 JSON 对象输出在顶层带 `version` 字段；逐行记录文件（`.jsonl`）与纯记录数组（JSON 格式的检索导出、`theoretical_debate_map_v1.json`）不带版本，由同一次调用写出的、带 `version` 的 meta 记录说明。

**规则**: 适用范围内的 artifact 文件名必须符合以下正则：

```
^[a-z]+_[a-z_]+(_\d{3})?_v\d+\.(json|tex|jsonl)$
```

**格式**: `<category>_<name>[_<index>]_v<N>.{json|tex|jsonl}`

**示例**:
```
✓ writing_token_budget_plan_v1.json
✓ writing_section_001_v1.json
✓ writing_evidence_packet_section_001_v2.json
✗ writing_section_001.json          (缺少版本)
✗ WritingSection001_v1.json         (大写)
```

**CI 验证**:
```bash
# 当前没有自动的命名 linter：原 lint 只扫描 hep-mcp 的 run 产物写入点，
# 这些写入点已随 hep-mcp 自带 run 一并移除。新 artifact 的命名在评审时核对。
```

**违规行为**: 评审中发现的不合规新 artifact 名应在合入前改正

> **例外 (R4)**: 审批 markdown 产物 (`packet_short.md`, `packet.md`) 由 GATE-05 管辖，不受 ART-01 正则约束。

### ART-02: 版本化双标记

**适用范围**: 同 ART-01（provider 研究输出不在此列，其约定见 ART-01）。

**规则**: 适用范围内的持久化 artifact 必须同时使用：
1. 文件名 `_v{N}` 后缀
2. JSON 内 `schema_version: N` 字段（顶层第一个字段）

两者必须一致。

**CI 验证**:
```bash
# 当前没有检查 artifact 文件名与 schema_version 一致性的自动检查；
# make codegen-check 只保证由 meta/schemas 生成的类型代码没有漂移。
# 新 artifact 的版本双标记在评审时核对。
```

**违规行为**: 评审中发现的版本不一致应在合入前改正

### ART-03: 原子写入

**规则**: 所有 artifact 写入必须是原子的：先完整写入暂存文件并 `fsync`，再赋予最终名字并 `fsync` 所在目录。禁止直接写到最终路径。赋名有两种方式：
1. **替换式**：`rename` 到最终名，由 `@nullius/shared` 的持久写入原语完成（`writeBytesAtomicDurable`、`writeJsonAtomicDurable`、`commitStagedDurable` 等），用于允许覆盖的文件，例如控制面状态。
2. **不替换式**：以硬链接（`link`）把暂存文件发布到最终名，遇到已有条目即失败、绝不替换，随后删除暂存名。用于 provider 工具写入调用方 `output_dir` 的研究输出（`packages/hep-mcp/src/core/outputDir.ts`）。一次调用的全部文件先暂存，再逐个发布，失败时撤回已发布的文件；撤回成功则全有或全无；若清理失败，错误会写明残留：已发布的文件删不掉时，错误为 UNSAFE_FS，写明输出不完整并在 `files_left` 中列出它们（残留的暂存文件列在 `staging_left`）；只有暂存文件删不掉时，保留原错误并附 `staging_left`；无法识别的暂存文件在 `staging_path` 中给出；删除之后若无法刷盘，错误为 UNSAFE_FS，说明清理可能经不起崩溃，并在 `unflushed_directories` 中列出相应目录。只有发布途中进程崩溃才可能留下未被报告的部分文件。之后点名这些文件的调用都会被拒绝。

**CI 验证**:
```bash
# 拒绝生产代码中裸的 writeFile/rename/appendFile 调用（允许清单与理由见脚本）
node scripts/check-atomic-write-anti-drift.mjs
```
不替换式发布不经 `rename`，不在该脚本的禁止模式内，其行为由 `packages/hep-mcp/tests/core/outputDirContainment.test.ts` 与 `outputDirStaging.test.ts` 覆盖。

**违规行为**: **fail-closed** — 裸写入阻断 CI

### ART-04: 载荷大小限制

**规则**: 会产生大量记录的工具把完整结果写入调用方指定的位置（如 hep-mcp 的 `output_dir`），只返回路径与摘要。其余 tool result 文本超过 `HARD_CAP_RESULT_BYTES`（按 UTF-8 字节计）时在字符边界截断并附截断标记，在 `MAX_INLINE_RESULT_BYTES` 与 `HARD_CAP_RESULT_BYTES` 之间则原样返回。`STDIO_MAX_RESULT_BYTES`（100KB）是这组上限的上界常量；stdio 封装另加的转义开销不在上述字节数内，目前也没有单独的运行时拦截。

**CI 验证**:
```bash
# 契约测试: 内联上限 < 截断上限 < stdio 上限 的层级，以及按 UTF-8 字节截断
pnpm --filter @nullius/hep-mcp test -- tests/contracts/payloadBackpressure.test.ts tests/contracts/resultTruncation.test.ts
```

**违规行为**: 超过截断上限而未截断的 tool result 属缺陷，须在合入前修正

### ART-05: 完整性验证

**规则**: 消费 `ArtifactRefV1` 的验证与审查步骤在读取 artifact 前必须核对 `sha256` 与 `size_bytes`（orchestrator 的 `loadVerifiedRunJson` / `resolveVerifiedRunArtifact`）。

研究笔记正文审查复用 verification subject/check-run/verdict/coverage 与
`ArtifactRef`，作为 supporting semantic check，不得冒充计算的 decisive validation。
审查输入须冻结完整 UTF-8 notebook（含自动块）及必要声明依赖的实际字节
SHA-256，包括未提交编辑；commit 或章节版本戳不能替代此身份绑定。任何字节
变化使既有审查 stale；历史报告保留原输入身份并保持可读。真实 reviewer 须记录
逐节全文覆盖及源锚定理由，检查推导完整性、逻辑、符号、定义、假设和约定；
缺失、部分、失败、unavailable、invalid 或 stale 不得作为当前通过。链接、自动表、
公式数量、勾选项与作者自评均非正文判定证据。file 与 engine closeout 使用同一
当前版本契约；结构导航与语义审查分别报告，语义 accepted 不证明科学真理，
reviewer 的模型、方法与输入独立性局限必须保留。


收敛 fold 与最终 file closeout 均调用无 scope 的 `nullius notebook check --json`；
`none` 声明及 launcher 缺失不豁免检查。`--result` 仅是结构范围诊断，不能替代
覆盖全部当前结果的最终默认检查。合法 UTF-8 文本不因体积变大而归为 `opaque_links`，Markdown 依赖递归发现。只有二进制或无效 UTF-8 的自动链接来源作为不可变快照及哈希定位符；报告须逐项说明 path/hash/`required_for_reasoning`，必要但未读的来源不能通过。notebook 与显式依赖须为严格 UTF-8，并使用 LF 或 CRLF。

完整原材料先冻结；存储预算与模型单次请求分开：`--snapshot-bytes` 默认 512 MiB、`--max-files` 默认 256，`--context-bytes` 控制请求体积，`--context-tokens` 声明可用后端的上下文窗口（默认 200,000 tokens，保留指令及输出余量）。默认以字节数作保守 token 上界；显式扩大字节预算后，如该上界超过窗口，则须有执行时记录的后端 token 用量。缺少容量证据、后端压缩原上下文或投递失败均不能通过。

大材料逐个原文区间审读，附相邻原文；随后联合审读接收完整 notebook 与所有文本依赖，检查跨章符号、定义、假设、约定和推理。所有区间与联合审读均完整且 fresh 才可接受，不能用精选引文或摘要代替原文。默认总执行预算 1200 秒、64 次调用（`--timeout-secs`、`--max-batches`），每次只有一次尝试，无自动重试。预算不足报告完整冻结量、待审区间、联合审读欠缺、原因及续审命令；材料枚举未完成时只报告已发现量，并明确闭包不完整。`--resume <run-id>` 新建运行并复核旧收据及原材料身份，保留显式依赖与存储预算，不改旧证据。完整联合原文若超出可用后端窗口，须提高实际可用容量或保持 incomplete。目前仅接受 tool mode `none`；多个批次仍是一次语义审查，不构成多份独立验证或跨家族 quorum。

**CI 验证**:
```bash
# 契约测试: 篡改审查证据 → 拒绝而不是沿用旧的通过
pnpm --filter @nullius/orchestrator test -- tests/notebook-content-review.test.ts
```

**违规行为**: **fail-closed** — 完整性校验失败拒绝处理

---

## 8. 安全执行 (SEC)

### SEC-01: 执行适配器隔离

**规则**: 执行适配器必须强制其已声明的路径边界、命令限制和可实现的时限；无法强制的硬资源请求应在授权和派发前拒绝。原生计算对直接子进程执行总运行时限和步骤时限，不提供 OS 沙箱，不保证任意后代或远程任务的终止；硬 CPU、内存和磁盘上限在准备阶段拒绝。领域专有路径与执行策略由对应适配器声明。

**CI 验证**:
```bash
pnpm --filter @nullius/orchestrator test -- tests/nullius-cli.test.ts
```

**违规行为**: **fail-closed** — 未隔离的执行适配器阻断 CI

### SEC-02: 不可信内容摄入沙箱

**规则**: 解压/解析不可信内容 (archive, PDF, LaTeX) 必须强制：Zip Slip 防护、最大解压字节数 (500MB)、最大文件数 (10000)、单任务超时。

**CI 验证**: 目前没有自动检验。此前列出的 `tests/core/sandbox.test.ts` 检验的是一个从未接入任何摄入路径的 ZIP 解压器，已随该模块一并删除（2026-10-12）。当前在用的归档摄入路径是 arXiv 源码包解压（`packages/arxiv-mcp/src/source/tarExtractor.ts`）：拒绝越出目标目录的条目，只接收普通文件与目录；最大解压字节数与最大文件数尚未强制，越界拒绝也没有专门测试，两者仍待补充。

**违规行为**: **fail-closed** — 未沙箱化的摄入路径阻断 CI（在上述检验补上之前，没有机制执行这一点）

### SEC-03: 工具风险分级与破坏性调用确认

**规则**: 每个 MCP `ToolSpec` 必须声明 `risk_level: 'read' | 'write' | 'destructive'`。`destructive` 工具必须要求调用方传入 `_confirm: true`，否则返回确认提示而非执行。deny-by-default。

**CI 验证**:
```bash
# 至少保持 tool risk / sampling surface tests 通过
pnpm --filter @nullius/orchestrator test -- tests/mcp-client-sampling.test.ts
```

**违规行为**: **staged fail-closed** (R3 升级) — 新增工具必须声明 `risk_level`，否则 CI 阻断；存量未标注工具 fail-open（警告），按 REDESIGN_PLAN H-11a 分阶段补齐。`_confirm` 机制待 H-11b 组合策略统一设计后全面启用。

> **Sunset (R4)**: Phase 2 完成后（或 H-11a 全部工具标注完成时），存量 fail-open 警告自动升级为 fail-closed。届时所有工具必须声明 `risk_level`，无例外。

---

## 9. 网络 (NET)

### NET-01: 出口域名白名单

**规则**: 外联 HTTP 请求域名必须匹配注册白名单 (`inspirehep.net`, `arxiv.org`, `127.0.0.1`, `api.semanticscholar.org`)。每域名附速率限制。

**CI 验证**:
```bash
# 当前没有独立的 repo-local network-allowlist linter。
# 先由 provider tests 与 fail-closed review 保持该约束。
```

**违规行为**: **fail-closed** — 非白名单域名请求被拒绝

---

## 10. 韧性 (RES)

### RES-01: 重试/退避/取消契约

**规则**: `retryable=true` 错误必须使用有界指数退避 (base=1s, max=60s, jitter=±25%)、重试预算上限 (默认 3 次)、标准化取消行为 (context cancellation 传播)。

**CI 验证**:
```bash
pnpm --filter @nullius/orchestrator test -- tests/retry.test.ts
```

**违规行为**: **fail-closed** — 无界重试或缺少退避的重试逻辑阻断 CI

---

## 11. 迁移 (MIG)

### MIG-01: Schema 迁移链强制

**规则**: 持久化 schema 版本升级必须：在 `migration_registry_v1.json` 中注册迁移条目、提供 N-1 版本 fixture 测试、附回滚说明。

**CI 验证**:
```bash
# 当前没有独立的 repo-local migration-registry linter。
# 至少保持 schema/codegen 同步门禁通过。
make codegen-check
```

**违规行为**: **fail-closed** — 缺少迁移条目的 schema 版本升级阻断 CI

---

## 12. 发布 (REL)

### REL-01: 发布偏差防护

**规则**: 创建 release tag 前，必须在干净检出上通过 `make release`。它依次执行：(1) `pnpm -r build`；(2) `make codegen-check`（SYNC-06：`packages/shared/src/generated/`、`meta/generated/python/` 重生成后无 diff）；(3) `meta/scripts/check_version_sync.sh` 与 `node scripts/check-version-consistency.mjs`（所有包版本一致）；(4) `pnpm --filter @nullius/hep-mcp catalog` 后 `tool_catalog.{standard,full}.json` 无 diff（SYNC-02）；(5) `node scripts/check-skill-tool-name-anti-drift.mjs`（技能引用的工具名与运行时注册表一致）。tag 必须指向通过以上全部检查的提交。`hep_health.tool_catalog_hash` 是客户端可钉住的运行时自检值，不是发布门。

**CI 验证**:
```bash
make release
```

**违规行为**: **fail-closed** — 任一步失败则不得创建 tag

### REL-02: 生成产物确定性 (R3 新增)

**规则**: 所有 CI 生成的契约产物（tool catalog、codegen 输出、Python bindings）必须确定性可复现。易变字段（时间戳、生成器版本）必须在 diff 前 normalize 或固定。codegen 工具版本必须在当前 monorepo 的 checked-in package / Python toolchain config 中锁定。

**CI 验证**:
```bash
# 连续两次生成 → diff → 必须一致
make codegen && cp -r */generated/ /tmp/gen1 && make codegen && diff -r */generated/ /tmp/gen1
```

**违规行为**: **fail-closed** — 非确定性生成产物阻断 CI

## 13. 代码质量 (CODE)

### CODE-01: 模块化与反模式强制

**规则**: 所有新增/修改代码必须遵守以下约束：

1. **单文件 ≤200 LOC** (有效代码行，不含空行和注释)。超过时必须拆分。
2. **禁止万能文件名**: `utils.{ts,py}`, `helpers.{ts,py}`, `common.{ts,py}`, `service.{ts,py}`, `misc.{ts,py}` 禁止作为业务逻辑容器。按功能域命名。
3. **入口文件仅 re-export**: `index.ts` / `__init__.py` 禁止包含业务逻辑。
4. **禁止类型安全逃逸**: `as any`, `@ts-ignore`, `@ts-expect-error`, `# type: ignore` 禁止使用。
5. **禁止静默吞错**: 空 catch 块 `catch(e) {}` / `except: pass` 禁止。
6. **禁止删测试过关**: 删除或 skip 失败测试以通过 CI 禁止。

**CI 验证**:
```bash
# LOC 检查 (TS + Python, diff-scoped 模式)
# 正式实现: meta/scripts/check_loc.py (计算非空非注释行，含缩进行)
# 已知局限 (Phase 3 升级为 AST-based lint 后消除):
#   - Python 多行 docstring ("""...""") 内容行被误计为代码
#   - TS 多行注释 (/* ... */) 中不以 * 开头的行被误计
#   - 方向偏保守 (高估 LOC)，不会漏报
# 临时 heuristic:
find . -name '*.ts' -o -name '*.py' | grep -v node_modules | grep -v __pycache__ | grep -v generated | \
  xargs -I{} sh -c 'LOC=$(grep -cvE "^\s*$|^\s*//|^\s*#|^\s*\*|^\s*/\*" "$1"); \
  if [ "$LOC" -gt 200 ]; then echo "$1: $LOC LOC"; fi' _ {}
# 万能文件名检查
find . -regex '.*\(utils\|helpers\|common\|service\|misc\)\.\(ts\|py\)' \
  -not -path '*/node_modules/*' -not -path '*/generated/*' && exit 1 || exit 0
# 类型逃逸检查 (CODE-01.4)
grep -rn 'as any\|@ts-ignore\|@ts-expect-error\|# type: ignore' \
  --include='*.ts' --include='*.py' \
  | grep -v 'node_modules\|__pycache__\|generated\|CONTRACT-EXEMPT' && exit 1 || exit 0
# 入口文件业务逻辑检查 (CODE-01.3, heuristic)
# 检查 index.ts/__init__.py 是否包含非 import/export/空行/注释 的代码
python3 meta/scripts/check_entry_files.py
# 静默吞错检查 (CODE-01.5, heuristic)
grep -Pzn 'catch\s*\([^)]*\)\s*\{\s*\}' --include='*.ts' -r . \
  | grep -v 'node_modules\|generated\|CONTRACT-EXEMPT' && exit 1 || exit 0
grep -rn 'except:\s*pass\|except\s.*:\s*pass' --include='*.py' \
  | grep -v '__pycache__\|generated\|CONTRACT-EXEMPT' && exit 1 || exit 0
```

**违规行为**: **fail-closed** — 违反任一条阻断 CI

**豁免**: `# CONTRACT-EXEMPT: CODE-01 {原因}` (需附具体条目编号，如 CODE-01.4)

> **存量代码**: Phase 1 起新代码强制（diff-scoped: 仅检查 git diff 中的新增/修改文件）；存量代码在 Phase 2 H-16b 契约测试 CI 中逐步对齐。

> **CI 升级路径**: 当前 LOC 计数 + 入口文件 + 静默吞错检查均为 grep/heuristic 临时实现。Phase 3 升级为 AST-based lint（TS: ESLint custom rule; Python: `ast` 模块），覆盖 CODE-01 全部 6 条子规则。

#### AMEND-01: CODE-01.1 文件级豁免 + 日落强制 (待批准)

> **状态**: 提案 (pending governance approval)
> **来源**: 2026-02 深度重构分析（现仅保留在本地 archive）, Codex R16/R23 审查反馈
> **依赖**: NEW-R02a (CI 脚本实际存在 + 金丝雀测试)
> **提出日期**: 2026-02-21

**背景**: CODE-01.1 (单文件 ≤200 LOC) 的现有豁免机制 `# CONTRACT-EXEMPT: CODE-01.1 {原因}` 设计为行内注释。但 LOC 检查的本质是文件级度量 — 在超标文件中添加行内豁免注释不会改变该文件的 LOC 计数。存量代码中存在大量超标文件 (深度重构分析统计: TS ≥200 LOC 文件约 30+, Python ≥200 LOC 文件约 15+)，需要一个文件级豁免机制来支持渐进式清理。

**提案内容**:

1. **文件级豁免标记** — 在文件**首 5 行**内放置以下注释即可豁免该文件的 CODE-01.1 LOC 检查:
   ```
   // CONTRACT-EXEMPT: CODE-01.1 sunset:YYYY-MM-DD {原因}    (TS)
   # CONTRACT-EXEMPT: CODE-01.1 sunset:YYYY-MM-DD {原因}     (Python)
   ```
   - `sunset:YYYY-MM-DD` 为**必填**字段，标注豁免到期日期
   - 不含 `sunset:` 的文件级 CODE-01.1 豁免 CI 拒绝
   - 其他 CODE-01 子规则 (CODE-01.2~01.6) 的行内豁免不受影响，无需 sunset

2. **日落强制执行** — CI 脚本 (`check_loc.py`) 检查日落日期:
   - 距日落 ≤30 天: CI **warn** (fail-open)
   - 超过日落日期: CI **fail-closed** — 豁免过期，必须拆分文件或延期 (需新 PR 更新日期)

3. **LOC 棘轮 (ratchet) 机制** (互补，不依赖本提案):
   - 维护本仓 checked-in 的 LOC ratchet baseline（若启用）: 记录每个超标文件的当前 LOC 上限
   - CI 检查: 文件 LOC 只允许 ≤ 记录值，不允许增长
   - 文件拆分后从棘轮清单移除
   - 此机制**不需要契约修订** — 作为 NEW-R02a CI 脚本的实现细节

4. **CI 验证脚本变更**:
   ```bash
   # check_loc.py 增强: 文件级豁免 + 日落检查
   python3 meta/scripts/check_loc.py --mode diff-scoped --sunset-warn 30
   ```

**影响范围**: 仅 CODE-01.1 (LOC 限制)。CODE-01.2~01.6 的现有行内豁免机制不变。

**批准后生效**: 合并至 ECOSYSTEM_DEV_CONTRACT.md 的 CODE-01 豁免段落，替换当前通用豁免说明。

---

## 14. 语言规范 (LANG)

### LANG-01: 代码与文档语言

**规则**:

1. **源代码全英文**: 所有源代码、注释、变量名、commit message、PR description 使用英文
2. **用户手册英文优先**: 英文文件为 canonical source；中文版是翻译产物，与英文文件同目录、以 `_zh` 后缀命名（`README.md` ↔ `docs/README_zh.md`，`docs/POSITIONING.md` ↔ `docs/POSITIONING_zh.md`；技能 references 用 `.zh.md`），在英文文本定稿后生成或更新。不设 `docs/en/`、`docs/zh/` 目录
3. **架构文档**: `AGENTS.md`, `ECOSYSTEM_DEV_CONTRACT.md` 等内部架构文档保持当前语言 (中文)，不受本规则约束

**CI 验证**:
```bash
# packages/*/src 下 .ts/.py 不得含 CJK 字符（generated/ 与带 CONTRACT-EXEMPT: LANG-01 的行除外）
node scripts/check-source-language-anti-drift.mjs
```

**违规行为**: **fail-closed** — 新增代码含 CJK 字符阻断 CI

**豁免**: `// CONTRACT-EXEMPT: LANG-01 {reason}` (如: 物理术语无标准英文翻译)

---

## 15. 组件可插拔 (PLUG)

### PLUG-01: 独立发布能力

**规则**: 以下核心组件必须设计为可独立发布的 npm package，零 Nullius 内部依赖：

| 组件 | npm scope | 对标 | 独立价值 |
|---|---|---|---|
| **REP SDK** | `@nullius/rep-sdk` | `@modelcontextprotocol/sdk` | 任何 AI 研究平台可用的研究进化协议 |
| **PDG MCP** | `@nullius/pdg-mcp` | 已独立 | 粒子数据查询 |
| **Zotero MCP** | `@nullius/zotero-mcp` | 已独立 | 文献管理集成 |

**约束**:
1. `@nullius/rep-sdk` 的 `dependencies` 不得含任何 `@nullius/*` 包（协议内核，所需助手内联）。`@nullius/pdg-mcp`、`@nullius/zotero-mcp` 的 `dependencies` 中 `@nullius/*` 只允许 `@nullius/shared`：它必须保持叶子包（自身 `dependencies` 不含 `@nullius/*`、非 `private`、与全仓同版本），随这两个包一同发布。禁止依赖 `@nullius/orchestrator`、`@nullius/hep-mcp`、其他 `*-mcp`、`idea-*`、`project-contracts`；`@nullius/*` 也不得出现在 `peerDependencies`（那只是把安装负担推给用户，耦合并未解除）
2. 必须有独立的 `README.md`（英文）+ 包级 `test` 脚本（由 `pnpm -r test` 运行）
3. `@nullius/rep-sdk` 的导出结构遵循 MCP SDK 模式：root / client / server / transport / validation 子路径；MCP 服务器包导出 root、`./tooling` 与 `bin` 入口即可

**CI 验证**:
```bash
# 三个可发布包的 @nullius/* 依赖白名单 + shared 保持叶子包
node scripts/check-publishable-package-deps-anti-drift.mjs
```

**违规行为**: **fail-closed** — 引入内部依赖阻断 CI

## 规则总表

| 域 | 规则 | 违规行为 | CI 验证方式 |
|---|---|---|---|
| **ERR** | ERR-01 统一错误信封 | fail-closed | lint: 裸 throw/raise 检查 |
| | ERR-02 retryable 标记 | fail-closed | 错误码注册表完整性 |
| | ERR-03 错误码保留 | fail-closed | 契约测试 |
| | ERR-04 run 上下文错误带 run_id（仅拥有 run 的组件） | fail-open | 集成测试 |
| **ID** | ID-01 Prefixed ID | fail-open | lint: ID 格式检查 |
| | ID-02 跨组件引用模型 | fail-open | 契约测试 |
| | ID-03 ArtifactRef V1 | fail-closed | 工具返回值检查 |
| **SYNC** | SYNC-01 Schema SHA256 | fail-closed | pre-commit + CI |
| | SYNC-02 工具清单自动生成 | fail-closed | catalog 比对测试 + diff 检查 |
| | SYNC-03 工具名常量化 | fail-closed | lint: 裸字符串检查 |
| | SYNC-04 运行时握手 | fail-open | 集成测试 |
| | SYNC-05 跨组件冒烟矩阵 | fail-closed | standard/full 冒烟测试 |
| | SYNC-06 跨语言类型代码生成 | fail-closed | codegen diff 检查 |
| | SYNC-07 新技能接线同步 | fail-open（review 阻断） | 验收清单 + market 依赖测试 |
| **CFG** | CFG-01 配置键注册表 | fail-open（review 阻断） | 评审核对 |
| | CFG-02 .env 加载一致性 | fail-closed | 集成测试 |
| | CFG-03 env 传播白名单 | fail-closed | 交叉验证 |
| | CFG-04 配置回显 | fail-open | 冒烟测试 |
| **GATE** | GATE-01 Gate 注册表 | fail-closed | 静态校验 |
| | GATE-02 GateSpec 抽象 | fail-closed | schema 验证 |
| | GATE-03 审批超时闭环 | fail-closed | 单元测试 |
| | GATE-04 审批预算强制 | fail-closed | 集成测试 |
| | GATE-05 审批三件套产物强制 | fail-closed | 产物完整性测试 |
| **LOG** | LOG-01 JSONL 格式 | fail-open | jq 解析测试 |
| | LOG-02 trace_id 透传 | fail-open | 集成测试 |
| | LOG-03 Ledger 事件类型 | fail-closed | 写入格式守卫 + 读模型测试 |
| | LOG-04 日志脱敏 | fail-closed | secrets 模式 grep |
| **ART** | ART-01 命名规范 | fail-open（review 阻断） | 评审核对 |
| | ART-02 版本化双标记 | fail-open（review 阻断） | 评审核对 |
| | ART-03 原子写入 | fail-closed | check-atomic-write-anti-drift |
| | ART-04 载荷大小限制 | fail-closed | 集成测试 |
| | ART-05 完整性验证 | fail-closed | 契约测试 |
| **SEC** | SEC-01 执行适配器隔离 | fail-closed | 沙箱测试 |
| | SEC-02 不可信内容摄入沙箱 | fail-closed | 解压/解析测试（待补） |
| | SEC-03 工具风险分级 | staged fail-closed | risk_level 声明检查 |
| **NET** | NET-01 出口域名白名单 | fail-closed | 白名单 lint |
| **RES** | RES-01 重试/退避/取消契约 | fail-closed | 重试策略测试 |
| **MIG** | MIG-01 Schema 迁移链强制 | fail-closed | 迁移注册表 lint |
| **REL** | REL-01 发布偏差防护 | fail-closed | make release 检查清单 |
| | REL-02 生成产物确定性 | fail-closed | 连续生成 diff 检查 |
| **CODE** | CODE-01 模块化与反模式强制 | fail-closed | LOC + 文件名 + 类型逃逸 lint |
| | ↳ AMEND-01 文件级豁免+日落 (待批准) | — | check_loc.py sunset 检查 |
| **LANG** | LANG-01 代码与文档语言 | fail-closed | check-source-language-anti-drift |
| **PLUG** | PLUG-01 独立发布能力 | fail-closed | check-publishable-package-deps-anti-drift |

**统计**: 43 条规则，32 条 fail-closed (含 SEC-03 staged)，7 条 fail-open，4 条 fail-open（review 阻断）

---

## 生效与迁移

1. **新代码**: 本规范发布后，所有新增/修改代码必须遵守全部规则
2. **存量代码**: 按当前 checked-in 架构/治理文档分阶段对齐，fail-open 规则允许渐进迁移
3. **豁免**: 特殊情况可通过在代码中添加 `# CONTRACT-EXEMPT: {规则ID} {原因}` 注释豁免，但必须在 PR review 中说明。CODE-01.1 文件级豁免需额外包含 `sunset:YYYY-MM-DD` (待 AMEND-01 批准后生效)
4. **版本演进**: 规则变更需经当前 monorepo 的 checked-in 治理流程审批
5. **待批准修订**: 标记为 `AMEND-{NN}` 的提案在治理审批前不具有强制力，仅供参考实施

独立复现的运行时须保留完整原始输入、成员输出、精确源码来源与执行证据。团队循环在启用复现门时通过 `--reproduction-packet` 或 `independent_reproduction.blind_packet` 接收独立的中性输入，不以候选材料的数字遮蔽替代。实际后续读取仍须审查；同一可靠方法或模型家族不自动拒绝，原实现重跑、输入污染、相关方法缺陷与作者声明不能计为独立确认。多评审汇总只接受源锚定且完整的共同判断，不拼接不同评审的部分判断；未通过的结果不得发布约定答案。

Capacity evidence requires an adjacent runtime observation of the actual successful invocation, including requests that fit the conservative byte bound. The local runtime binds the complete original request, actual report locator, working directory and captured bytes using its host authority; recalculating project artifact hashes cannot create that observation. Verification trusts the runtime and owning OS account, and does not authenticate provider truth or scientific correctness. Historical unsigned records remain readable, but cannot supply new capacity acceptance; they are never retrospectively signed.

Interrupted notebook reviews resume in a fresh run from immutable intake and batch checkpoints, retaining original bytes and rechecking current material. Only completed, fresh, runtime-observed primary interval receipts can be reused; the complete-original joint audit is always executed again. Missing closure, stale sources or incomplete operations remain unavailable or incomplete. Member reproduction evidence requires an authenticated actual producer episode and the complete source/data inputs bound to the executed command; declared inputs and bounded static discovery do not prove arbitrary filesystem activity.

Runtime observations bind the actual report location, so copying signed capture bytes cannot authenticate a new invocation elsewhere. Member episodes freeze every observed file into durable original storage before publication; successful workspace cleanup preserves subsequent verification. Records lacking these bindings remain readable and unavailable for new acceptance.

Member origin trusts the configured runner and owning host runtime: the complete runner bytes are recorded, but no runner allowlist or provider attestation is claimed. Offline or injected host execution establishes a local process/callable observation; actual provider capacity evidence requires the corresponding CLI capture. The canonical team cycle performs a postflight source assessment and a separate fresh assessment at the final consumer; both use the configured assessor request/execution budgets.

The owning account can read the authority key, including code executed by a member under that account; this authenticates against non-executing artifact tampering, not hostile same-account code. No OS sandbox or provider attestation is supplied.

The configured token window is frozen before the original reviewer subprocess starts and bound into its authenticated runtime observation. Changing historical window metadata cannot admit that receipt. Older observations without this policy remain readable and require a fresh execution for capacity acceptance.

Local directory links leave notebook dependency closure pending and prevent acceptance. The complete-original joint audit requires exact substantive original-byte anchors for every interval; a reasoning checkbox alone cannot supply coverage.
