# 跨语言对齐 — Python↔TS SSOT 经验

## [2026-02-24] NEW-05a Stage 1: orchestrator TS↔Python 对齐

**上下文**: packages/orchestrator/ (TS) 必须与 packages/hep-autoresearch/ (Python) 共享 state.json + ledger.jsonl
**关联项**: NEW-05a, C-01

### Python 是 SSOT

Stage 1 期间 Python 是唯一写入方，TS 只读。所有 TS 类型必须**精确镜像** Python 写入的 JSON 结构。

### 关键对齐点（已验证）

| 数据结构 | Python 位置 | TS 位置 | 注意事项 |
|----------|------------|---------|---------|
| `default_state()` | orchestrator_state.py:119 | types.ts `RunState` | 字段名、类型、默认值一一对应 |
| `append_ledger_event()` | orchestrator_state.py:608 | types.ts `LedgerEvent` | 字段: ts, event_type, run_id, workflow_id, step_id, details |
| `pending_approval` | orchestrator_cli.py:1507 | types.ts `PendingApproval` | 字段: approval_id, category, plan_step_ids, requested_at, timeout_at, on_timeout, packet_path |
| `approval_history[]` | orchestrator_cli.py:1618 | types.ts `ApprovalHistoryEntry` | 字段: ts, approval_id, category, decision, note |
| `current_step` | orchestrator_cli.py:341 | types.ts `CurrentStep` | dict 不是 string! 字段: step_id, title, started_at |
| `run_status` 枚举 | orchestrator_cli.py 各处 | types.ts `RunStatus` | 必须包含 awaiting_approval |
| `gate_satisfied` | orchestrator_cli.py | types.ts | 值是 approval_id string，不是 boolean |
| `budgets.max_approvals` | orchestrator_state.py:780 | state-manager.ts:97 | 嵌套在 budgets 下，不是顶层 |

### 序列化对齐

- Python `json.dumps(event, sort_keys=True)` → TS 必须用 `sortKeysRecursive()` + `JSON.stringify()` (无 replacer)
- ⚠️ 绝对不要用 `JSON.stringify(obj, keyArray)` 做排序 — keyArray 是全局白名单，会丢弃嵌套数据
- SHA-256 规范化: 需统一分隔符约定（建议双方都用 compact `separators=(',',':')` / 无空格）
