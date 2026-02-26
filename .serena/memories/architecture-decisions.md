## Architecture Decisions

### [2026-02-26] H-05: FileLock Non-Reentrancy

**上下文**: Phase 2 Batch 3 — H-05 cross-platform file lock
**发现**: `fcntl.flock` on Linux treats different file descriptors independently. Same-process re-acquisition on different fds WILL deadlock (not reentrant). This is NOT the case on macOS where flock is per-open-file-description.
**影响**: FileLock 的 docstring 必须明确声明 NOT reentrant。所有使用 state_lock 的函数不得嵌套调用。`persist_state_with_ledger_event` 要求 caller 持有锁，自身不获取锁。
**关联项**: H-05

### [2026-02-26] TOCTOU Pattern: Always Re-check Inside Lock

**上下文**: Phase 2 Batch 3 — R1-R3 review cycle
**发现**: 状态变更函数必须在锁内重新读取状态并重新验证所有触发条件，不仅是 run_status。Gemini 审核抓住了 `maybe_mark_needs_recovery` 只重新检查了 run_status 但没有重新检查 checkpoint 时间戳。
**影响**: 所有 "先检查后锁定" 的模式必须在锁内完整重复检查逻辑。参考 `check_approval_timeout` 的实现作为模板。
**关联项**: H-05, H-09

### [2026-02-26] Python StrEnum Compatibility

**上下文**: Phase 2 Batch 3 — H-10 EventType enum
**发现**: `StrEnum` requires Python 3.11+. For 3.9+ compat, use `class EventType(str, Enum)`. Note: `str(EventType.X)` returns `'EventType.X'` on Python 3.12, not the value. Use `.value` or direct comparison (which works because str subclass).
**影响**: 测试不要用 `assertEqual(str(et), et.value)`，改用 `assertEqual(et, et.value)`.
**关联项**: H-10

### [2026-02-25] Batch 2: Token budget inheritance chain

**上下文**: Phase 2 Batch 2 — M-05
**发现**: `tokenizer_model` 需要 plan→gate 继承链: param → plan.tokenizer_model → default ("cl100k_base")
**关联项**: M-05

### [2026-02-25] Batch 2: Python CI resilience

**上下文**: Phase 2 Batch 2 — CI fixes
**发现**: Python CI jobs should use `continue-on-error: true` at job level, not `|| true` on individual steps.
**关联项**: CI infrastructure

### [2026-02-24] H-21/NEW-R13: Data Dir Alignment

**上下文**: Phase 0 + Phase 2 — package rename + data dir unification
**发现**: `.hep-research-mcp` → `.hep-mcp` throughout. docstring in `default_hep_data_dir` must say `<repo_root>/.hep-mcp`, not `~/.hep-mcp`.
**关联项**: H-21, NEW-R13
