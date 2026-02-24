from __future__ import annotations

import json
from pathlib import Path
import time
from typing import Any

import pytest

from idea_core.hepar.control_plane import HeparControlPlaneStore, WorkOrder
from idea_core.hepar.runtime_adapter import OpenCodeRuntimeAdapter, ToolPolicyEnforcer


class FakeOpenCodeClient:
    def __init__(self) -> None:
        self.created_sessions: list[dict] = []
        self.messages: list[dict] = []
        self.permissions: list[dict] = []
        self.events_by_session: dict[str, list[dict]] = {}

    def create_session(self, *, work_id: str, input_artifacts: list[str], tool_policy: dict) -> str:
        session_id = f"session-{work_id}"
        self.created_sessions.append(
            {
                "work_id": work_id,
                "input_artifacts": input_artifacts,
                "tool_policy": tool_policy,
                "session_id": session_id,
            }
        )
        return session_id

    def post_message(self, *, session_id: str, message: str) -> dict:
        self.messages.append({"session_id": session_id, "message": message})
        return {
            "status": "ok",
            "summary": "role finished",
            "outputs": [f"file:///tmp/{session_id}/result.json"],
            "model": "opencode-agent",
        }

    def post_permission(
        self,
        *,
        session_id: str,
        permission_id: str,
        action: str,
        remember: bool,
    ) -> None:
        self.permissions.append(
            {
                "session_id": session_id,
                "permission_id": permission_id,
                "action": action,
                "remember": remember,
            }
        )

    def stream_global_events(self, *, session_id: str):
        return iter(self.events_by_session.get(session_id, []))


class FlakySessionClient(FakeOpenCodeClient):
    def __init__(self, *, fail_times: int) -> None:
        super().__init__()
        self.fail_times = fail_times
        self.create_attempts = 0

    def create_session(self, *, work_id: str, input_artifacts: list[str], tool_policy: dict) -> str:
        self.create_attempts += 1
        if self.create_attempts <= self.fail_times:
            raise ConnectionError("session api unavailable")
        return super().create_session(work_id=work_id, input_artifacts=input_artifacts, tool_policy=tool_policy)


class SlowPermissionClient(FakeOpenCodeClient):
    def __init__(self, *, delay_s: float) -> None:
        super().__init__()
        self.delay_s = delay_s

    def post_permission(
        self,
        *,
        session_id: str,
        permission_id: str,
        action: str,
        remember: bool,
    ) -> None:
        time.sleep(self.delay_s)
        super().post_permission(
            session_id=session_id,
            permission_id=permission_id,
            action=action,
            remember=remember,
        )


def _work_order(*, allow: list[str] | None = None, write_roots: list[str] | None = None) -> WorkOrder:
    return WorkOrder(
        work_id="work-200",
        campaign_id="c200",
        idea_id="i200",
        island_id="island-0",
        role_id="Checker",
        input_artifacts=["file:///tmp/in-a.json", "file:///tmp/in-b.json"],
        output_schema_ref="schema://work-result-v1",
        tool_policy={
            "mode": "ask",
            "allow": allow or [],
            "write_roots": write_roots or [],
        },
        budget={"max_tokens": 2000, "max_wall_clock_s": 60},
        idempotency_key="idem-work-200",
        deadline="2026-02-13T20:00:00Z",
        priority="medium",
    )


def test_execute_work_order_creates_session_posts_message_and_records_ledger(tmp_path: Path) -> None:
    store = HeparControlPlaneStore(root_dir=tmp_path / "hepar")
    client = FakeOpenCodeClient()
    adapter = OpenCodeRuntimeAdapter(control_plane_store=store, client=client)

    result = adapter.execute_work_order(
        _work_order(allow=["shell"], write_roots=[str(tmp_path / "safe")]),
        role_message="review this candidate",
    )

    assert client.created_sessions
    assert client.created_sessions[0]["work_id"] == "work-200"
    assert client.messages == [{"session_id": "session-work-200", "message": "review this candidate"}]
    assert result.work_id == "work-200"
    assert result.status == "ok"

    event_types = [event["event_type"] for event in store.read_ledger_events()]
    assert "runtime.session_started" in event_types
    assert "work_result.recorded" in event_types


def test_permission_handshake_writes_gate_events_and_posts_response(tmp_path: Path) -> None:
    store = HeparControlPlaneStore(root_dir=tmp_path / "hepar")
    client = FakeOpenCodeClient()
    adapter = OpenCodeRuntimeAdapter(control_plane_store=store, client=client)

    work_order = _work_order(allow=["shell"])
    response = adapter.handle_permission_request(
        work_order=work_order,
        session_id="session-work-200",
        request_event={
            "permission_id": "perm-1",
            "tool": "shell",
            "path": None,
        },
        gate_decision={"action": "allow", "remember": True},
    )

    assert response["action"] == "allow"
    assert response["remember"] is True
    assert client.permissions == [
        {
            "session_id": "session-work-200",
            "permission_id": "perm-1",
            "action": "allow",
            "remember": True,
        }
    ]

    event_types = [event["event_type"] for event in store.read_ledger_events()]
    assert "runtime.permission_requested" in event_types
    assert "runtime.permission_resolved" in event_types


def test_sse_observability_writes_permission_and_execution_hash_events(tmp_path: Path) -> None:
    store = HeparControlPlaneStore(root_dir=tmp_path / "hepar")
    client = FakeOpenCodeClient()
    client.events_by_session["session-work-200"] = [
        {
            "type": "permission_request",
            "permission_id": "perm-sse",
            "tool": "mcp",
        },
        {
            "type": "execution_summary",
            "summary": "checker finished",
            "outputs": ["file:///tmp/out.json"],
        },
    ]
    adapter = OpenCodeRuntimeAdapter(control_plane_store=store, client=client)

    consumed = adapter.ingest_sse_events(
        work_order=_work_order(),
        session_id="session-work-200",
    )

    assert consumed == 2
    events = store.read_ledger_events()
    sse_execution = [event for event in events if event["event_type"] == "runtime.execution_summary"]
    assert sse_execution
    assert sse_execution[0]["artifact_hash"].startswith("sha256:")


def test_tool_policy_default_deny_and_fs_whitelist_enforced(tmp_path: Path) -> None:
    (tmp_path / "safe").mkdir(parents=True, exist_ok=True)
    policy = ToolPolicyEnforcer.from_work_order(
        _work_order(allow=["fs"], write_roots=[str(tmp_path / "safe")])
    )

    assert policy.is_tool_allowed("shell", requested_path=None, gate_approved=True) is False
    assert policy.is_tool_allowed("fs", requested_path="/tmp/absolute.txt", gate_approved=True) is False
    assert policy.is_tool_allowed("fs", requested_path="file://evilhost/tmp/ok.txt", gate_approved=True) is False
    assert policy.is_tool_allowed("fs", requested_path="../unsafe/x.txt", gate_approved=True) is False
    assert policy.is_tool_allowed("fs", requested_path="ok.txt", gate_approved=True) is True
    assert policy.is_tool_allowed("mcp", requested_path=None, gate_approved=False) is False


def test_tool_policy_rejects_path_traversal(tmp_path: Path) -> None:
    safe_root = tmp_path / "safe"
    safe_root.mkdir(parents=True, exist_ok=True)
    policy = ToolPolicyEnforcer.from_work_order(
        _work_order(allow=["fs"], write_roots=[str(safe_root)])
    )

    traversal = str(safe_root / ".." / "outside.txt")
    assert policy.is_tool_allowed("fs", requested_path=traversal, gate_approved=True) is False


def test_tool_policy_rejects_symlink_escape_outside_write_root(tmp_path: Path) -> None:
    safe_root = tmp_path / "safe"
    outside_root = tmp_path / "outside"
    safe_root.mkdir(parents=True, exist_ok=True)
    outside_root.mkdir(parents=True, exist_ok=True)
    (outside_root / "leak.txt").write_text("x", encoding="utf-8")

    (safe_root / "escape").symlink_to(outside_root, target_is_directory=True)
    policy = ToolPolicyEnforcer.from_work_order(
        _work_order(allow=["fs"], write_roots=[str(safe_root)])
    )

    escaped = str(safe_root / "escape" / "leak.txt")
    assert policy.is_tool_allowed("fs", requested_path=escaped, gate_approved=True) is False


def test_sse_replay_events_are_deduplicated_by_event_id(tmp_path: Path) -> None:
    store = HeparControlPlaneStore(root_dir=tmp_path / "hepar")
    client = FakeOpenCodeClient()
    replayed = {
        "event_id": "evt-001",
        "type": "permission_request",
        "permission_id": "perm-replay",
        "tool": "shell",
    }
    client.events_by_session["session-work-200"] = [replayed, replayed]
    adapter = OpenCodeRuntimeAdapter(control_plane_store=store, client=client)

    consumed = adapter.ingest_sse_events(work_order=_work_order(), session_id="session-work-200")

    assert consumed == 1
    permission_events = [
        event for event in store.read_ledger_events() if event["event_type"] == "runtime.permission_requested"
    ]
    assert len(permission_events) == 1


def test_sse_ingest_dedup_does_not_use_per_event_full_ledger_scan(tmp_path: Path) -> None:
    store = HeparControlPlaneStore(root_dir=tmp_path / "hepar")
    client = FakeOpenCodeClient()
    client.events_by_session["session-work-200"] = [
        {"event_id": f"evt-{idx}", "type": "execution_summary", "summary": "done", "outputs": []}
        for idx in range(50)
    ]
    adapter = OpenCodeRuntimeAdapter(control_plane_store=store, client=client)

    def _forbidden_has_ledger_event(**_: Any) -> bool:
        raise AssertionError("ingest_sse_events should not call has_ledger_event per event")

    store.has_ledger_event = _forbidden_has_ledger_event  # type: ignore[method-assign]
    consumed = adapter.ingest_sse_events(work_order=_work_order(), session_id="session-work-200")

    assert consumed == 50


def test_sse_dedup_does_not_collapse_same_event_id_across_sessions(tmp_path: Path) -> None:
    store = HeparControlPlaneStore(root_dir=tmp_path / "hepar")
    client = FakeOpenCodeClient()
    shared_event = {
        "event_id": "evt-shared",
        "type": "execution_summary",
        "summary": "session event",
        "outputs": [],
    }
    client.events_by_session["session-a"] = [shared_event]
    client.events_by_session["session-b"] = [shared_event]
    adapter = OpenCodeRuntimeAdapter(control_plane_store=store, client=client)

    consumed_a = adapter.ingest_sse_events(work_order=_work_order(), session_id="session-a")
    consumed_b = adapter.ingest_sse_events(work_order=_work_order(), session_id="session-b")

    assert consumed_a == 1
    assert consumed_b == 1


def test_sse_ingest_stops_at_max_events_and_emits_guard_event(tmp_path: Path) -> None:
    store = HeparControlPlaneStore(root_dir=tmp_path / "hepar")
    client = FakeOpenCodeClient()
    client.events_by_session["session-work-200"] = [
        {"event_id": "evt-1", "type": "execution_summary", "summary": "s1", "outputs": []},
        {"event_id": "evt-2", "type": "execution_summary", "summary": "s2", "outputs": []},
    ]
    adapter = OpenCodeRuntimeAdapter(control_plane_store=store, client=client)

    consumed = adapter.ingest_sse_events(
        work_order=_work_order(),
        session_id="session-work-200",
        max_events=1,
    )

    assert consumed == 1
    guard_events = [event for event in store.read_ledger_events() if event["event_type"] == "runtime.sse_limit_reached"]
    assert len(guard_events) == 1
    assert guard_events[0]["reason"] == "max_events"


def test_sse_ingest_stops_at_wall_clock_limit_and_emits_guard_event(tmp_path: Path) -> None:
    store = HeparControlPlaneStore(root_dir=tmp_path / "hepar")

    class SlowClient(FakeOpenCodeClient):
        def stream_global_events(self, *, session_id: str):
            for idx in range(3):
                time.sleep(0.02)
                yield {"event_id": f"evt-slow-{idx}", "type": "execution_summary", "summary": "slow", "outputs": []}

    client = SlowClient()
    adapter = OpenCodeRuntimeAdapter(control_plane_store=store, client=client)

    consumed = adapter.ingest_sse_events(
        work_order=_work_order(),
        session_id="session-work-200",
        max_events=100,
        max_wall_s=0.01,
    )

    assert consumed == 0
    guard_events = [event for event in store.read_ledger_events() if event["event_type"] == "runtime.sse_limit_reached"]
    assert len(guard_events) == 1
    assert guard_events[0]["reason"] == "max_wall_s"


def test_sse_ingest_accepts_opencode_fixture_event_shapes(tmp_path: Path) -> None:
    fixture_path = Path(__file__).parent / "fixtures" / "opencode_sse_session_v1.jsonl"
    fixture_events = [
        json.loads(line) for line in fixture_path.read_text(encoding="utf-8").splitlines() if line.strip()
    ]

    store = HeparControlPlaneStore(root_dir=tmp_path / "hepar")
    client = FakeOpenCodeClient()
    client.events_by_session["session-work-200"] = fixture_events
    adapter = OpenCodeRuntimeAdapter(control_plane_store=store, client=client)

    consumed = adapter.ingest_sse_events(work_order=_work_order(), session_id="session-work-200")

    assert consumed == 3
    event_types = {event["event_type"] for event in store.read_ledger_events()}
    assert "runtime.permission_requested" in event_types
    assert "runtime.execution_summary" in event_types
    assert "runtime.event_observed" in event_types


def test_execute_work_order_records_failure_when_runtime_post_message_raises(tmp_path: Path) -> None:
    store = HeparControlPlaneStore(root_dir=tmp_path / "hepar")

    class FailingClient(FakeOpenCodeClient):
        def post_message(self, *, session_id: str, message: str) -> dict:
            raise RuntimeError("runtime unavailable")

    adapter = OpenCodeRuntimeAdapter(control_plane_store=store, client=FailingClient())
    result = adapter.execute_work_order(_work_order(allow=["shell"]), role_message="compute now")

    assert result.status == "failed"
    failure_events = [event for event in store.read_ledger_events() if event["event_type"] == "runtime.session_failed"]
    assert len(failure_events) == 1
    assert failure_events[0]["error_type"] == "RuntimeError"


def test_permission_post_failure_is_recorded_and_denied(tmp_path: Path) -> None:
    store = HeparControlPlaneStore(root_dir=tmp_path / "hepar")

    class PermissionFailClient(FakeOpenCodeClient):
        def post_permission(
            self,
            *,
            session_id: str,
            permission_id: str,
            action: str,
            remember: bool,
        ) -> None:
            raise ConnectionError("permission channel down")

    adapter = OpenCodeRuntimeAdapter(control_plane_store=store, client=PermissionFailClient())
    response = adapter.handle_permission_request(
        work_order=_work_order(allow=["shell"]),
        session_id="session-work-200",
        request_event={"permission_id": "perm-fail", "tool": "shell", "path": None},
        gate_decision={"action": "allow", "remember": True},
    )

    assert response["action"] == "deny"
    failed_events = [event for event in store.read_ledger_events() if event["event_type"] == "runtime.permission_failed"]
    assert len(failed_events) == 1
    assert failed_events[0]["error_type"] == "ConnectionError"


def test_execute_work_order_retries_transient_session_create_failures(tmp_path: Path) -> None:
    store = HeparControlPlaneStore(root_dir=tmp_path / "hepar")
    client = FlakySessionClient(fail_times=2)
    adapter = OpenCodeRuntimeAdapter(
        control_plane_store=store,
        client=client,
        external_max_attempts=3,
        external_timeout_s=0.2,
        external_backoff_initial_s=0.001,
        external_backoff_max_s=0.002,
    )

    result = adapter.execute_work_order(_work_order(allow=["shell"]), role_message="compute now")

    assert result.status == "ok"
    assert client.create_attempts == 3


def test_permission_post_timeout_has_bounded_retries_and_denies(tmp_path: Path) -> None:
    store = HeparControlPlaneStore(root_dir=tmp_path / "hepar")
    adapter = OpenCodeRuntimeAdapter(
        control_plane_store=store,
        client=SlowPermissionClient(delay_s=0.05),
        external_max_attempts=2,
        external_timeout_s=0.005,
        external_backoff_initial_s=0.001,
        external_backoff_max_s=0.002,
    )

    response = adapter.handle_permission_request(
        work_order=_work_order(allow=["shell"]),
        session_id="session-work-200",
        request_event={"permission_id": "perm-timeout", "tool": "shell", "path": None},
        gate_decision={"action": "allow", "remember": True},
    )

    assert response["action"] == "deny"
    assert "timed out" in response["error"]


def test_ingest_permission_requests_can_be_resolved_reactively(tmp_path: Path) -> None:
    store = HeparControlPlaneStore(root_dir=tmp_path / "hepar")
    client = FakeOpenCodeClient()
    client.events_by_session["session-work-200"] = [
        {"event_id": "evt-perm", "type": "permission_request", "permission_id": "perm-rt", "tool": "shell"},
    ]
    adapter = OpenCodeRuntimeAdapter(control_plane_store=store, client=client)
    seen: list[dict[str, Any]] = []

    consumed = adapter.ingest_sse_events(
        work_order=_work_order(allow=["shell"]),
        session_id="session-work-200",
        on_permission_request=lambda event: seen.append(event) or {"action": "allow", "remember": False},
    )

    assert consumed == 1
    assert len(seen) == 1
    assert client.permissions == [
        {
            "session_id": "session-work-200",
            "permission_id": "perm-rt",
            "action": "allow",
            "remember": False,
        }
    ]
    event_types = [event["event_type"] for event in store.read_ledger_events()]
    assert "runtime.permission_requested" in event_types
    assert "runtime.permission_resolved" in event_types


def test_execute_work_order_filters_runtime_env_with_env_whitelist(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("KEEP_ME", "yes")
    monkeypatch.setenv("DROP_ME", "no")

    store = HeparControlPlaneStore(root_dir=tmp_path / "hepar")
    client = FakeOpenCodeClient()
    adapter = OpenCodeRuntimeAdapter(control_plane_store=store, client=client)
    work_order = _work_order(allow=["shell"])
    work_order = WorkOrder(
        **{
            **work_order.to_dict(),
            "tool_policy": {
                **work_order.tool_policy,
                "env_whitelist": ["KEEP_ME", "MISSING_ENV"],
            },
        }
    )

    _ = adapter.execute_work_order(work_order, role_message="env check")

    sent_policy = client.created_sessions[0]["tool_policy"]
    assert sent_policy["env_whitelist"] == ["KEEP_ME", "MISSING_ENV"]
    assert sent_policy["env"] == {"KEEP_ME": "yes"}
    assert "DROP_ME" not in sent_policy["env"]
