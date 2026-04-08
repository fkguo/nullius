# Autoresearch 生态圈开发规范 (Ecosystem Development Contract)

> **版本**: 1.3.0-draft (R2: +SEC-03/SYNC-05/REL-01, CI upgrade path, M-19 severity; R3: SEC-03 staged fail-closed, +GATE-05/REL-02, SYNC-02 determinism; R5: +CODE-01 模块化与反模式强制, CI 脚本修正 + diff-scoped 分阶段执行; R6: CFG-01 修正 HEP_DATA_DIR 默认值, +CODE-01 治理提案 AMEND-01)
> **日期**: 2026-04-08
> **适用范围**: hep-research-mcp, hep-autoresearch, idea-generator, idea-engine, skills/, skills-market, autoresearch-meta；`idea-core` 仅作为退役中的内部 parity / fixture residue 在需要处提及
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
  "domain": "string (组件名: hep-mcp | idea-engine | hepar | skill)",
  "code": "string (错误码)",
  "message": "string (人类可读)",
  "retryable": "boolean",
  "run_id": "string | null",
  "trace_id": "string (UUID v4)",
  "data": "object | null (附加上下文)"
}
```

**CI 验证**:
```bash
# lint: 检查所有 throw/raise 语句是否使用 AutoresearchError 工厂
grep -rn 'throw new Error\|raise Exception' --include='*.ts' --include='*.py' \
  | grep -v 'node_modules\|__pycache__\|test' \
  | grep -v 'AutoresearchError\|McpError\|RpcError' && exit 1 || exit 0
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
# 检查错误码注册表完整性
python autoresearch-meta/scripts/validate_error_registry.py
```

**违规行为**: **fail-closed** — 未注册的错误码阻断 CI

### ERR-03: McpStdioClient 错误码保留

**规则**: Python 侧 `McpStdioClient.call_tool_json()` 返回值必须包含原始 `error_code` 字段，不得丢弃 MCP 错误码。

**CI 验证**:
```bash
# 契约测试: 模拟 MCP RATE_LIMIT 响应 → 验证 result.error_code == "RATE_LIMIT"
pytest hep-autoresearch/tests/test_mcp_error_propagation.py -k "test_error_code_preserved"
```

**违规行为**: **fail-closed** — 错误码丢失导致调用方无法区分可重试/不可重试错误

### ERR-04: 错误响应禁止 run_id: null

**规则**: 当错误发生在 run 上下文中时，`run_id` 必须填充实际值。仅在无 run 上下文时允许 `null`。

**CI 验证**:
```bash
# 集成测试: 在 run 上下文中触发错误 → 验证 run_id 非 null
pytest autoresearch-meta/tests/integration/ -k "test_error_run_id_not_null"
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
# lint: 检查新代码中的 ID 生成是否使用 prefixed 格式
python autoresearch-meta/scripts/lint_id_format.py --check-new-only
```

**违规行为**: **fail-open** (警告) — 旧 ID 通过映射表互操作，新 ID 强制前缀

### ID-02: 跨组件引用模型

**规则**: 跨组件传递实体引用时，必须使用结构化引用而非裸 ID：

```json
{
  "component": "hep-mcp | hepar | idea-engine",
  "kind": "project | run | campaign | node | artifact",
  "id": "prefixed_uuid"
}
```

**CI 验证**:
```bash
# 契约测试: 跨组件 API 调用参数中的 ID 字段必须为结构化引用或 prefixed string
python autoresearch-meta/scripts/validate_cross_refs.py
```

**违规行为**: **fail-open** (警告) — 渐进迁移

### ID-03: ArtifactRef V1 强制

**规则**: 所有跨组件 artifact 指针必须使用 `ArtifactRefV1`：

```json
{
  "uri": "hep://runs/{run_id}/artifact/{name}",
  "kind": "evidence_catalog | section_draft | token_budget | ...",
  "schema_version": 1,
  "sha256": "hex string",
  "size_bytes": 12345,
  "produced_by": "tool_name@version",
  "created_at": "ISO 8601 UTC Z"
}
```

**CI 验证**:
```bash
# 检查所有返回 artifact URI 的工具是否同时返回 ArtifactRefV1
node autoresearch-meta/scripts/validate_artifact_refs.mjs
```

**违规行为**: **fail-closed** — 缺少完整性字段的 artifact 引用阻断 CI

---

## 3. 契约同步 (SYNC)

### SYNC-01: Schema 快照 SHA256 门禁

**规则**: `idea-engine/contracts/idea-generator-snapshot/` 中的 package-local vendored schema 是当前 runtime-default authority，必须与 `idea-generator/schemas/` 的 SHA256 指纹一致。退役中的 `idea-core/contracts/idea-generator-snapshot/` 若仍保留，只能作为内部 parity residue，且不得与同一 fingerprint 漂移。

**CI 验证**:
```bash
# runtime-default authority must stay package-local to idea-engine
pnpm --filter @autoresearch/idea-engine test -- tests/runtime-asset-authority.test.ts
# retirement residue still must not drift while idea-core remains in-tree
cd idea-core && make check-drift
# 内部逻辑: sha256sum idea-generator/schemas/*.schema.json | sort | sha256sum
#           比对 CONTRACT_SOURCE.json / package-local snapshot fingerprint
```

**违规行为**: **fail-closed** — 指纹不匹配阻断 CI 和 commit

### SYNC-02: 工具清单自动生成

**规则**: `tool_catalog.{standard,full}.json` 必须由 CI 自动生成（`pnpm catalog`），禁止手动编辑。文件包含 commit hash + 生成时间戳。CI diff 前必须 normalize 易变字段（时间戳、生成器版本）以避免误报。

**CI 验证**:
```bash
# CI: 重新生成 catalog → normalize 易变字段 → diff → 不一致则失败
pnpm catalog && python autoresearch-meta/scripts/normalize_catalog.py tool_catalog.*.json && git diff --exit-code tool_catalog.*.json
```

**违规行为**: **fail-closed** — catalog 与运行时 `listTools()` 不一致阻断 CI

### SYNC-03: 工具名常量化

**规则**: hep-autoresearch 中所有 MCP 工具调用必须使用生成的常量（`mcp_tools.py`），禁止裸字符串。

**CI 验证**:
```bash
# lint: 检查 call_tool_json() 调用是否使用常量
grep -rn 'call_tool_json.*"[a-z_]*"' hep-autoresearch/src/ \
  | grep -v 'mcp_tools\.' && exit 1 || exit 0
```

**违规行为**: **fail-closed** — 裸字符串工具名阻断 CI

> **CI 升级路径**: 当前 grep 检查为临时实现。Phase 3 升级为 AST-based lint，精确匹配 `call_tool_json()` 调用参数。

### SYNC-04: 运行时兼容性握手

**规则**: 已删除的 legacy shell wrapper（如 `hepar doctor`）不再是 live 握手 authority。当前运行时兼容性握手必须由 lower-level MCP contract / tool inventory 验证承担，至少覆盖 `initialize → hep_health / tool contracts → tools/list` 这一条链路。

**CI 验证**:
```bash
# lower-level MCP contract + inventory verification
pnpm --filter @autoresearch/hep-mcp test -- tests/toolContracts.test.ts
pnpm --filter @autoresearch/hep-mcp docs:tool-counts:check
```

**违规行为**: **fail-open** (警告 + 降级运行) — hash 不匹配时警告但允许继续（避免升级死锁）

### SYNC-05: 跨组件冒烟矩阵

**规则**: CI 必须覆盖 `standard` 和 `full` 两种 MCP tool inventory truth，但不再依赖已经删除的 `doctor` / `bridge` parser shells。当前 smoke 必须走 package-local contract/tool-listing 验证，而不是复活 legacy compatibility wrapper。

**CI 验证**:
```bash
# standard/full tool inventory + contract verification
pnpm --filter @autoresearch/hep-mcp docs:tool-counts:check
pnpm --filter @autoresearch/hep-mcp test -- tests/tools.test.ts tests/toolContracts.test.ts
```

**违规行为**: **fail-closed** — 冒烟测试失败阻断 CI

### SYNC-06: 跨语言类型代码生成门禁

**规则**: `meta/schemas/` 下的 JSON Schema 为所有跨语言共享类型的唯一 SSOT。TS 接口（`json-schema-to-typescript`）和 Python 生成模型 / bindings（`datamodel-code-generator`，当前输出为 `meta/generated/python/` 下的 Pydantic v2 artifacts）必须由 CI 自动生成。禁止手写跨语言镜像类型。

**CI 验证**:
```bash
make codegen-check  # 重新生成 → git diff --exit-code */generated/
```

**违规行为**: **fail-closed** — 生成代码与 committed 不一致阻断 CI

## 4. 配置 (CFG)

### CFG-01: 配置键注册表

**规则**: 所有环境变量/配置键必须在 `autoresearch-meta/docs/ecosystem_config_v1.md` 中注册，包含：键名、类型、默认值、优先级链、所属组件。

| 键 | 类型 | 默认值 | 优先级 | 组件 |
|---|---|---|---|---|
| `HEP_DATA_DIR` | path | `.hep-research-mcp` (CWD 相对路径) | env > .env > default | hep-research-mcp |
| `HEP_TOOL_MODE` | enum | `standard` | env > .env > default | hep-research-mcp |
| `HEP_ENABLE_ZOTERO` | bool | `true` | env > .env > default | hep-research-mcp |
| `PDG_DB_PATH` | path | (必需) | env > .env | pdg-mcp |
| `PDG_ARTIFACT_TTL_HOURS` | int | `24` | env > .env > default | pdg-mcp |
| `ZOTERO_BASE_URL` | URL | `http://127.0.0.1:23119` | env > .env > default | zotero-mcp |

> **H-21 计划变更**: `HEP_DATA_DIR` 默认值将从项目本地 `.hep-research-mcp` (CWD 相对) 变更为全局 `~/.hep-research-mcp` (用户主目录)。变更在 H-21 实施时同步更新本表。

**CI 验证**:
```bash
# 检查代码中引用的 env var 是否全部在注册表中
python autoresearch-meta/scripts/lint_config_keys.py
```

**违规行为**: **fail-closed** — 未注册的配置键阻断 CI

### CFG-02: .env 加载一致性

**规则**: 所有组件入口必须尝试加载 CWD `.env` 文件（`override: false`，即不覆盖已设置的环境变量）。

**CI 验证**:
```bash
# 集成测试: .env 中设置 HEP_TOOL_MODE=full → 验证 MCP server 暴露 83 工具
pytest autoresearch-meta/tests/integration/test_env_loading.py
```

**违规行为**: **fail-closed** — 配置不一致导致"shell 中正常，编排器中失败"

### CFG-03: 环境变量传播白名单

**规则**: hep-autoresearch 的 `McpStdioClient` env 白名单必须包含所有 `CFG-01` 注册表中的键。新增配置键时必须同步更新白名单。

**CI 验证**:
```bash
# 交叉验证: 注册表键 ⊆ McpStdioClient 白名单
python autoresearch-meta/scripts/validate_env_whitelist.py
```

**违规行为**: **fail-closed** — 配置键未传播阻断 CI

### CFG-04: 配置回显

**规则**: 已删除的 `hepar doctor` 不再承担配置回显 authority。当前配置可观测性必须由 lower-level diagnostics / contract tests 承担，至少保证与 `hep_health`、tool contracts、tool inventory 相关的关键配置不会退化成静默黑箱。

**CI 验证**:
```bash
# lower-level diagnostics / contract verification
pnpm --filter @autoresearch/hep-mcp test -- tests/toolContracts.test.ts
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

**CI 验证**:
```bash
# 静态校验: run_card 中的 gate 必须在注册表中
python autoresearch-meta/scripts/validate_gates.py --check-run-cards
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
# schema 验证: gate_spec_v1.schema.json 通过 Draft 2020-12
python autoresearch-meta/scripts/validate_schemas.py schemas/gate_spec_v1.schema.json
```

**违规行为**: **fail-closed** — 不符合 GateSpec 的 gate 定义阻断 CI

### GATE-03: 审批超时执行闭环

**规则**: 审批 watchdog 必须在 `status`/`run`/`approve` 路径统一检查 `timeout_at`。超时后根据 `on_timeout` 策略执行状态迁移并写入 ledger 事件。`on_timeout` 枚举: `block`(默认) | `reject` | `escalate`。

**CI 验证**:
```bash
# 单元测试: 设置过期 timeout_at → 验证 watchdog 触发
pytest hep-autoresearch/tests/test_approval_watchdog.py
```

**违规行为**: **fail-closed** — 超时未执行策略视为治理绕过

### GATE-04: 审批预算强制

**规则**: 审批策略中声明的预算限制必须在运行时强制检查，不得仅作为展示字段。

**CI 验证**:
```bash
# 集成测试: 预算耗尽后尝试 approve → 验证被拒绝
pytest hep-autoresearch/tests/test_approval_budget.py
```

**违规行为**: **fail-closed** — 预算绕过视为治理失效

### GATE-05: 审批三件套产物强制 (R3 新增)

**规则**: 每次审批请求必须同时生成三份产物：`packet_short.md`（≤1 页摘要）、`packet.md`（全量细节）、`approval_packet_v1.json`（结构化，符合 `approval_packet_v1.schema.json`）。缺少任一产物视为审批请求不完整。

**CI 验证**:
```bash
# 集成测试: 触发审批 → 验证三份产物均存在且 JSON 通过 schema 验证
pytest hep-autoresearch/tests/test_approval_packet_triple.py
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
# 检查日志输出可被 jq 解析
hepar run --dry-run 2>&1 | grep '^{' | jq -e '.ts and .level and .component' > /dev/null
```

**违规行为**: **fail-open** (警告) — 渐进迁移，新组件强制

### LOG-02: trace_id 全链路透传

**规则**: 每次 MCP tool call 必须携带 `trace_id` (UUID v4)。`trace_id` 必须贯穿 MCP → orchestrator → ledger → 日志。

**CI 验证**:
```bash
# 集成测试: 发起 MCP 调用 → 验证 ledger 事件含相同 trace_id
pytest autoresearch-meta/tests/integration/test_trace_propagation.py
```

**违规行为**: **fail-open** (警告) — 缺少 trace_id 不阻断但降低可观测性

### LOG-03: Ledger 事件类型枚举

**规则**: `orchestrator_state.append_ledger()` 的 `event_type` 必须属于已注册枚举。枚举值：

```
workflow_start, workflow_end, phase_start, phase_end,
approval_request, approval_granted, approval_denied, approval_timeout,
state_transition, error, checkpoint
```

**CI 验证**:
```bash
# lint: 检查 append_ledger 调用的 event_type 是否在枚举中
python autoresearch-meta/scripts/lint_ledger_events.py
```

**违规行为**: **fail-closed** — 非枚举 event_type 写入时抛出 ValueError

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
# 集成测试: 设置含 API key 的环境 → 运行 → grep 日志无泄露
pytest autoresearch-meta/tests/test_log_redaction.py
```

**违规行为**: **fail-closed** — 日志含 secrets 模式阻断 CI

---

## 7. Artifact (ART)

### ART-01: 命名规范

**规则**: 所有 artifact 文件名必须符合以下正则：

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
python autoresearch-meta/scripts/lint_artifact_names.py \
  --pattern '^[a-z]+_[a-z_]+(_\d{3})?_v\d+\.(json|tex|jsonl)$'
```

**违规行为**: **fail-closed** — 不符合命名规范的新 artifact 阻断 CI

> **例外 (R4)**: 审批 markdown 产物 (`packet_short.md`, `packet.md`) 由 GATE-05 管辖，不受 ART-01 正则约束。lint 脚本中显式豁免。

### ART-02: 版本化双标记

**规则**: 所有持久化 artifact 必须同时使用：
1. 文件名 `_v{N}` 后缀
2. JSON 内 `schema_version: N` 字段（顶层第一个字段）

两者必须一致。

**CI 验证**:
```bash
# 检查文件名版本与内部 schema_version 一致
python autoresearch-meta/scripts/lint_artifact_versions.py
```

**违规行为**: **fail-closed** — 版本不一致阻断 CI

### ART-03: 原子写入

**规则**: 所有 artifact 写入必须使用原子操作：write `.tmp` → `fsync` → `rename`。禁止直接 `writeFile` 到最终路径。

**CI 验证**:
```bash
# lint: 检查 writeFile/open('w') 调用是否使用 atomicWrite 封装
grep -rn 'writeFile\|writeFileSync' hep-research-mcp/src/ \
  | grep -v 'atomicWriteFile\|node_modules\|test' && exit 1 || exit 0
```

**违规行为**: **fail-closed** — 非原子写入阻断 CI

> **CI 升级路径**: 当前 grep 检查为临时实现。Phase 3 升级为 AST-based lint，精确匹配非 `atomicWriteFile` 封装的写入调用。

### ART-04: 载荷大小限制

**规则**: MCP tool result 最大 100KB。超限必须溢出到 artifact + 返回 `{truncated: true, artifact_uri, summary}`。

**CI 验证**:
```bash
# 集成测试: 返回 200KB 的工具 → 验证自动截断
pytest autoresearch-meta/tests/integration/test_payload_truncation.py
```

**违规行为**: **fail-closed** — 超限未截断的 tool result 阻断（运行时拦截）

### ART-05: 完整性验证

**规则**: 质量关键步骤（写作流水线 submit_*）在消费 artifact 前必须验证 `ArtifactRefV1.sha256` + `size_bytes`。

**CI 验证**:
```bash
# 契约测试: 篡改 artifact 内容 → 验证 submit 拒绝
pytest hep-research-mcp/tests/test_artifact_integrity.py
```

**违规行为**: **fail-closed** — 完整性校验失败拒绝处理

---

## 8. 安全执行 (SEC)

### SEC-01: 执行适配器隔离

**规则**: 所有执行适配器 (ShellAdapter 等) 必须强制：输出路径白名单 (仅 `repo_root/` 及 `HEP_DATA_DIR`)、命令黑名单 (`rm -rf /`, `curl|sh` 等)、资源配额 (CPU 时间、内存、文件大小上限)。

**CI 验证**:
```bash
pytest hep-autoresearch/tests/test_shell_sandbox.py
```

**违规行为**: **fail-closed** — 未隔离的执行适配器阻断 CI

### SEC-02: 不可信内容摄入沙箱

**规则**: 解压/解析不可信内容 (archive, PDF, LaTeX) 必须强制：Zip Slip 防护、最大解压字节数 (500MB)、最大文件数 (10000)、单任务超时。

**CI 验证**:
```bash
pytest hep-research-mcp/tests/test_safe_extract.py
```

**违规行为**: **fail-closed** — 未沙箱化的摄入路径阻断 CI

### SEC-03: 工具风险分级与破坏性调用确认

**规则**: 每个 MCP `ToolSpec` 必须声明 `risk_level: 'read' | 'write' | 'destructive'`。`destructive` 工具必须要求调用方传入 `_confirm: true`，否则返回确认提示而非执行。deny-by-default。

**CI 验证**:
```bash
# 检查所有 ToolSpec 是否声明 risk_level
node autoresearch-meta/scripts/validate_tool_risk_levels.mjs
```

**违规行为**: **staged fail-closed** (R3 升级) — 新增工具必须声明 `risk_level`，否则 CI 阻断；存量未标注工具 fail-open（警告），按 REDESIGN_PLAN H-11a 分阶段补齐。`_confirm` 机制待 H-11b 组合策略统一设计后全面启用。

> **Sunset (R4)**: Phase 2 完成后（或 H-11a 全部工具标注完成时），存量 fail-open 警告自动升级为 fail-closed。届时所有工具必须声明 `risk_level`，无例外。

---

## 9. 网络 (NET)

### NET-01: 出口域名白名单

**规则**: 外联 HTTP 请求域名必须匹配注册白名单 (`inspirehep.net`, `arxiv.org`, `127.0.0.1`, `api.semanticscholar.org`)。每域名附速率限制。

**CI 验证**:
```bash
python autoresearch-meta/scripts/lint_network_allowlist.py
```

**违规行为**: **fail-closed** — 非白名单域名请求被拒绝

---

## 10. 韧性 (RES)

### RES-01: 重试/退避/取消契约

**规则**: `retryable=true` 错误必须使用有界指数退避 (base=1s, max=60s, jitter=±25%)、重试预算上限 (默认 3 次)、标准化取消行为 (context cancellation 传播)。

**CI 验证**:
```bash
pytest hep-autoresearch/tests/test_retry_policy.py
```

**违规行为**: **fail-closed** — 无界重试或缺少退避的重试逻辑阻断 CI

---

## 11. 迁移 (MIG)

### MIG-01: Schema 迁移链强制

**规则**: 持久化 schema 版本升级必须：在 `migration_registry_v1.json` 中注册迁移条目、提供 N-1 版本 fixture 测试、附回滚说明。

**CI 验证**:
```bash
python autoresearch-meta/scripts/lint_migration_registry.py
```

**违规行为**: **fail-closed** — 缺少迁移条目的 schema 版本升级阻断 CI

---

## 12. 发布 (REL)

### REL-01: 发布偏差防护

**规则**: Release tag 创建前必须：(1) 重新生成 `tool_catalog.{standard,full}.json` 和 Python bindings (`mcp_tools.py`)；(2) 验证 `tool_catalog_hash` 与 Python bindings 中的 `EXPECTED_CATALOG_HASH` 一致。允许 TS/Python 独立发布，但接口 hash 必须匹配。

**CI 验证**:
```bash
# release gate: 重新生成 + hash 比对
make release-check  # 内部: pnpm catalog → generate mcp_tools.py → diff hash
```

**违规行为**: **fail-closed** — hash 不匹配阻断 tag 创建

### REL-02: 生成产物确定性 (R3 新增)

**规则**: 所有 CI 生成的契约产物（tool catalog、codegen 输出、Python bindings）必须确定性可复现。易变字段（时间戳、生成器版本）必须在 diff 前 normalize 或固定。codegen 工具版本必须在 `autoresearch-meta/package.json` / `pyproject.toml` 中锁定。

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
# 正式实现: autoresearch-meta/scripts/check_loc.py (计算非空非注释行，含缩进行)
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
python autoresearch-meta/scripts/check_entry_files.py
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
> **来源**: `docs/2026-02-20-deep-refactoring-analysis.md` §1, Codex R16/R23 审查反馈
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
   - 维护 `autoresearch-meta/baselines/loc_ratchet.json`: 记录每个超标文件的当前 LOC 上限
   - CI 检查: 文件 LOC 只允许 ≤ 记录值，不允许增长
   - 文件拆分后从棘轮清单移除
   - 此机制**不需要契约修订** — 作为 NEW-R02a CI 脚本的实现细节

4. **CI 验证脚本变更**:
   ```bash
   # check_loc.py 增强: 文件级豁免 + 日落检查
   python autoresearch-meta/scripts/check_loc.py --mode diff-scoped --sunset-warn 30
   ```

**影响范围**: 仅 CODE-01.1 (LOC 限制)。CODE-01.2~01.6 的现有行内豁免机制不变。

**批准后生效**: 合并至 ECOSYSTEM_DEV_CONTRACT.md 的 CODE-01 豁免段落，替换当前通用豁免说明。

---

## 14. 语言规范 (LANG)

### LANG-01: 代码与文档语言

**规则**:

1. **源代码全英文**: 所有源代码、注释、变量名、commit message、PR description 使用英文
2. **用户手册英文优先**: 英文版为 canonical source (`docs/en/`)；中文版为翻译产物 (`docs/zh/`)，功能完工后批量生成
3. **架构文档**: `AGENTS.md`, `ECOSYSTEM_DEV_CONTRACT.md` 等内部架构文档保持当前语言 (中文)，不受本规则约束

**CI 验证**:
```bash
# 检查 src/ 下 .ts/.py 文件是否包含 CJK 字符 (注释和字符串中)
grep -rPn '[\x{4e00}-\x{9fff}]' --include='*.ts' --include='*.py' src/ \
  | grep -v 'node_modules\|generated\|CONTRACT-EXEMPT' && exit 1 || exit 0
```

**违规行为**: **fail-closed** — 新增代码含 CJK 字符阻断 CI

**豁免**: `// CONTRACT-EXEMPT: LANG-01 {reason}` (如: 物理术语无标准英文翻译)

---

## 15. 组件可插拔 (PLUG)

### PLUG-01: 独立发布能力

**规则**: 以下核心组件必须设计为可独立发布的 npm package，零 Autoresearch 内部依赖：

| 组件 | npm scope | 对标 | 独立价值 |
|---|---|---|---|
| **REP SDK** | `@autoresearch/rep-sdk` | `@modelcontextprotocol/sdk` | 任何 AI 研究平台可用的研究进化协议 |
| **PDG MCP** | `@autoresearch/pdg-mcp` | 已独立 | 粒子数据查询 |
| **Zotero MCP** | `@autoresearch/zotero-mcp` | 已独立 | 文献管理集成 |

**约束**:
1. 可独立发布组件的 `package.json` 中 `dependencies` 不得包含 `@autoresearch/*` 内部包 (shared types 通过 `peerDependencies` 或内联)
2. 必须有独立的 `README.md` (英文) + 独立的 CI test target
3. 导出结构遵循 MCP SDK 模式: root / client / server / transport / validation 子路径

**CI 验证**:
```bash
# 检查可独立发布包的 dependencies 无内部引用
node -e "
const pkg = require('./packages/rep-sdk/package.json');
const deps = Object.keys(pkg.dependencies || {});
const internal = deps.filter(d => d.startsWith('@autoresearch/'));
if (internal.length) { console.error('PLUG-01:', internal); process.exit(1); }
"
```

**违规行为**: **fail-closed** — 引入内部依赖阻断 CI

## 规则总表

| 域 | 规则 | 违规行为 | CI 验证方式 |
|---|---|---|---|
| **ERR** | ERR-01 统一错误信封 | fail-closed | lint: 裸 throw/raise 检查 |
| | ERR-02 retryable 标记 | fail-closed | 错误码注册表完整性 |
| | ERR-03 错误码保留 | fail-closed | 契约测试 |
| | ERR-04 run_id 非 null | fail-open | 集成测试 |
| **ID** | ID-01 Prefixed ID | fail-open | lint: ID 格式检查 |
| | ID-02 跨组件引用模型 | fail-open | 契约测试 |
| | ID-03 ArtifactRef V1 | fail-closed | 工具返回值检查 |
| **SYNC** | SYNC-01 Schema SHA256 | fail-closed | pre-commit + CI |
| | SYNC-02 工具清单自动生成 | fail-closed | CI diff 检查 |
| | SYNC-03 工具名常量化 | fail-closed | lint: 裸字符串检查 |
| | SYNC-04 运行时握手 | fail-open | 集成测试 |
| | SYNC-05 跨组件冒烟矩阵 | fail-closed | standard/full 冒烟测试 |
| | SYNC-06 跨语言类型代码生成 | fail-closed | codegen diff 检查 |
| **CFG** | CFG-01 配置键注册表 | fail-closed | lint: 未注册键检查 |
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
| | LOG-03 Ledger 事件枚举 | fail-closed | lint 检查 |
| | LOG-04 日志脱敏 | fail-closed | secrets 模式 grep |
| **ART** | ART-01 命名规范 | fail-closed | 正则 lint |
| | ART-02 版本化双标记 | fail-closed | 一致性检查 |
| | ART-03 原子写入 | fail-closed | lint: writeFile 检查 |
| | ART-04 载荷大小限制 | fail-closed | 集成测试 |
| | ART-05 完整性验证 | fail-closed | 契约测试 |
| **SEC** | SEC-01 执行适配器隔离 | fail-closed | 沙箱测试 |
| | SEC-02 不可信内容摄入沙箱 | fail-closed | 解压/解析测试 |
| | SEC-03 工具风险分级 | staged fail-closed | risk_level 声明检查 |
| **NET** | NET-01 出口域名白名单 | fail-closed | 白名单 lint |
| **RES** | RES-01 重试/退避/取消契约 | fail-closed | 重试策略测试 |
| **MIG** | MIG-01 Schema 迁移链强制 | fail-closed | 迁移注册表 lint |
| **REL** | REL-01 发布偏差防护 | fail-closed | release hash 比对 |
| | REL-02 生成产物确定性 | fail-closed | 连续生成 diff 检查 |
| **CODE** | CODE-01 模块化与反模式强制 | fail-closed | LOC + 文件名 + 类型逃逸 lint |
| | ↳ AMEND-01 文件级豁免+日落 (待批准) | — | check_loc.py sunset 检查 |
| **LANG** | LANG-01 代码与文档语言 | fail-closed | CJK 字符 grep 检查 |
| **PLUG** | PLUG-01 独立发布能力 | fail-closed | 内部依赖 lint |

**统计**: 42 条规则，35 条 fail-closed (含 SEC-03 staged)，7 条 fail-open

---

## 生效与迁移

1. **新代码**: 本规范发布后，所有新增/修改代码必须遵守全部规则
2. **存量代码**: 按当前 checked-in 架构/治理文档分阶段对齐，fail-open 规则允许渐进迁移
3. **豁免**: 特殊情况可通过在代码中添加 `# CONTRACT-EXEMPT: {规则ID} {原因}` 注释豁免，但必须在 PR review 中说明。CODE-01.1 文件级豁免需额外包含 `sunset:YYYY-MM-DD` (待 AMEND-01 批准后生效)
4. **版本演进**: 规则变更需经 autoresearch-meta 治理流程审批
5. **待批准修订**: 标记为 `AMEND-{NN}` 的提案在治理审批前不具有强制力，仅供参考实施
