from __future__ import annotations

import json
from pathlib import Path

from idea_core.hepar.control_plane import (
    HeparControlPlaneStore,
    TeamPlan,
    WorkOrder,
    WorkResult,
)


def _load_json(uri: str) -> dict:
    assert uri.startswith("file://")
    path = Path(uri[7:])
    return json.loads(path.read_text(encoding="utf-8"))


def _sample_work_order() -> WorkOrder:
    return WorkOrder(
        work_id="work-001",
        campaign_id="c123",
        idea_id="i123",
        island_id="island-0",
        role_id="Checker",
        input_artifacts=["file:///tmp/evidence-a.json"],
        output_schema_ref="schema://work-result-v1",
        tool_policy={"mode": "ask", "allow": []},
        budget={"max_tokens": 1200, "max_wall_clock_s": 30},
        idempotency_key="idem-work-001",
        deadline="2026-02-13T18:00:00Z",
        priority="high",
    )


def test_record_work_order_writes_artifact_and_ledger_event(tmp_path: Path) -> None:
    store = HeparControlPlaneStore(root_dir=tmp_path / "hepar")
    work_order = _sample_work_order()

    record = store.record_work_order(work_order)

    payload = _load_json(record["artifact_ref"])
    assert payload["work_id"] == "work-001"
    assert payload["idempotency_key"] == "idem-work-001"

    events = store.read_ledger_events()
    assert len(events) == 1
    assert events[0]["event_type"] == "work_order.created"
    assert events[0]["work_id"] == "work-001"
    assert events[0]["idempotency_key"] == "idem-work-001"
    assert events[0]["artifact_hash"].startswith("sha256:")


def test_record_work_result_links_work_id_and_status(tmp_path: Path) -> None:
    store = HeparControlPlaneStore(root_dir=tmp_path / "hepar")
    store.record_work_order(_sample_work_order())

    result = WorkResult(
        work_id="work-001",
        status="ok",
        outputs=["file:///tmp/result-a.json"],
        summary="checker accepted",
        provenance={"model": "opus", "role": "Checker", "prompt_hash": "sha256:abc"},
    )
    record = store.record_work_result(result)

    payload = _load_json(record["artifact_ref"])
    assert payload["work_id"] == "work-001"
    assert payload["status"] == "ok"

    events = store.read_ledger_events()
    assert len(events) == 2
    assert events[1]["event_type"] == "work_result.recorded"
    assert events[1]["work_id"] == "work-001"
    assert events[1]["status"] == "ok"


def test_register_team_plan_writes_roles_and_ledger_event(tmp_path: Path) -> None:
    store = HeparControlPlaneStore(root_dir=tmp_path / "hepar")

    plan = TeamPlan(
        team_id="team-alpha",
        coordination_policy="parallel",
        roles=[
            {
                "role_id": "Referee",
                "output_schema_ref": "schema://referee-v1",
                "tool_policy": {"mode": "ask", "allow": []},
            },
            {
                "role_id": "Checker",
                "output_schema_ref": "schema://checker-v1",
                "tool_policy": {"mode": "ask", "allow": []},
            },
        ],
        merge_policy={"strategy": "consensus_v1"},
        clean_room=True,
    )

    record = store.register_team_plan(plan)

    payload = _load_json(record["artifact_ref"])
    assert payload["team_id"] == "team-alpha"
    assert len(payload["roles"]) == 2

    events = store.read_ledger_events()
    assert len(events) == 1
    assert events[0]["event_type"] == "team_plan.registered"
    assert events[0]["team_id"] == "team-alpha"


def test_has_ledger_event_uses_session_event_keys(tmp_path: Path) -> None:
    store = HeparControlPlaneStore(root_dir=tmp_path / "hepar")
    store.append_ledger_event(
        "runtime.event_observed",
        session_id="session-1",
        event_key="execution_summary:evt-1",
    )

    assert store.has_ledger_event(session_id="session-1", event_key="execution_summary:evt-1") is True
    assert store.has_ledger_event(session_id="session-1", event_key="execution_summary:missing") is False
    assert store.has_ledger_event(session_id="session-2", event_key="execution_summary:evt-1") is False
