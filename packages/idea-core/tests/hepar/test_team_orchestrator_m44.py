from __future__ import annotations

import json
from pathlib import Path

from idea_core.engine.store import EngineStore
from idea_core.hepar.control_plane import HeparControlPlaneStore, TeamPlan, WorkResult
from idea_core.hepar.orchestrator import TeamRoleOrchestrator


class FakeRuntimeExecutor:
    def __init__(self, *, status_by_role: dict[str, str], outputs_by_role: dict[str, list[str]] | None = None) -> None:
        self.status_by_role = status_by_role
        self.outputs_by_role = outputs_by_role or {}
        self.calls: list[dict] = []

    def execute_work_order(self, work_order, *, role_message: str) -> WorkResult:
        self.calls.append(
            {
                "work_id": work_order.work_id,
                "role_id": work_order.role_id,
                "input_artifacts": list(work_order.input_artifacts),
                "role_message": role_message,
            }
        )
        status = self.status_by_role.get(work_order.role_id, "ok")
        outputs = self.outputs_by_role.get(
            work_order.role_id,
            [f"file:///tmp/{work_order.work_id}/result.json"],
        )
        return WorkResult(
            work_id=work_order.work_id,
            status=status,
            outputs=outputs,
            summary=f"{work_order.role_id}:{status}",
            provenance={"role": work_order.role_id, "runtime": "fake"},
        )


def _load_artifact(uri: str) -> dict:
    assert uri.startswith("file://")
    path = Path(uri[7:])
    return json.loads(path.read_text(encoding="utf-8"))


def test_parallel_referee_checker_merges_back_into_idea_store(tmp_path: Path) -> None:
    control_store = HeparControlPlaneStore(root_dir=tmp_path / "hepar")
    idea_store = EngineStore(root_dir=tmp_path / "idea_store")
    runtime = FakeRuntimeExecutor(status_by_role={"Referee": "ok", "Checker": "ok"})
    orchestrator = TeamRoleOrchestrator(
        control_plane_store=control_store,
        runtime_executor=runtime,
        idea_store=idea_store,
    )

    team_plan = TeamPlan(
        team_id="team-review",
        coordination_policy="parallel",
        roles=[
            {"role_id": "Referee"},
            {"role_id": "Checker"},
        ],
        merge_policy={"strategy": "referee_checker"},
        clean_room=True,
    )

    result = orchestrator.run_team_plan(
        team_plan=team_plan,
        campaign_id="campaign-44",
        idea_id="idea-44",
        island_id="island-0",
        node_id="node-44",
        input_artifacts=["file:///tmp/seed.json"],
        role_messages={"Referee": "clean-room referee", "Checker": "clean-room checker"},
        tool_policy={"mode": "ask", "allow": ["shell"], "write_roots": [str(tmp_path)]},
        budget={"max_tokens": 2000, "max_wall_clock_s": 120},
        deadline="2026-02-14T00:00:00Z",
    )

    assert result["status"] == "ok"
    assert sorted(call["role_id"] for call in runtime.calls) == ["Checker", "Referee"]
    for call in runtime.calls:
        assert call["input_artifacts"] == ["file:///tmp/seed.json"]

    merged = _load_artifact(result["merged_artifact_ref"])
    assert merged["campaign_id"] == "campaign-44"
    assert merged["node_id"] == "node-44"
    assert sorted(entry["role_id"] for entry in merged["role_results"]) == ["Checker", "Referee"]

    event_types = [event["event_type"] for event in control_store.read_ledger_events()]
    assert "team_orchestration.merged" in event_types


def test_stage_gated_blocks_later_stage_when_gate_fails(tmp_path: Path) -> None:
    control_store = HeparControlPlaneStore(root_dir=tmp_path / "hepar")
    idea_store = EngineStore(root_dir=tmp_path / "idea_store")
    runtime = FakeRuntimeExecutor(status_by_role={"Referee": "failed", "Checker": "ok"})
    orchestrator = TeamRoleOrchestrator(
        control_plane_store=control_store,
        runtime_executor=runtime,
        idea_store=idea_store,
    )

    team_plan = TeamPlan(
        team_id="team-stage-gate",
        coordination_policy="stage_gated",
        roles=[
            {"role_id": "Referee", "stage": 1},
            {"role_id": "Checker", "stage": 2},
        ],
        merge_policy={"stage_gate": "all_must_succeed"},
        clean_room=True,
    )

    result = orchestrator.run_team_plan(
        team_plan=team_plan,
        campaign_id="campaign-44",
        idea_id="idea-44",
        island_id="island-0",
        node_id="node-44",
        input_artifacts=["file:///tmp/seed.json"],
        role_messages={"Referee": "first stage", "Checker": "second stage"},
        tool_policy={"mode": "ask", "allow": ["shell"], "write_roots": [str(tmp_path)]},
        budget={"max_tokens": 2000, "max_wall_clock_s": 120},
        deadline="2026-02-14T00:00:00Z",
    )

    assert result["status"] == "blocked"
    assert [call["role_id"] for call in runtime.calls] == ["Referee"]

    event_types = [event["event_type"] for event in control_store.read_ledger_events()]
    assert "team_orchestration.stage_blocked" in event_types


def test_sequential_non_clean_room_passes_previous_outputs_to_next_role(tmp_path: Path) -> None:
    control_store = HeparControlPlaneStore(root_dir=tmp_path / "hepar")
    idea_store = EngineStore(root_dir=tmp_path / "idea_store")
    runtime = FakeRuntimeExecutor(
        status_by_role={"Referee": "ok", "Checker": "ok"},
        outputs_by_role={"Referee": ["file:///tmp/referee-review.json"]},
    )
    orchestrator = TeamRoleOrchestrator(
        control_plane_store=control_store,
        runtime_executor=runtime,
        idea_store=idea_store,
    )

    team_plan = TeamPlan(
        team_id="team-seq",
        coordination_policy="sequential",
        roles=[
            {"role_id": "Referee"},
            {"role_id": "Checker"},
        ],
        merge_policy={"strategy": "sequential"},
        clean_room=False,
    )

    result = orchestrator.run_team_plan(
        team_plan=team_plan,
        campaign_id="campaign-44",
        idea_id="idea-44",
        island_id="island-0",
        node_id="node-44",
        input_artifacts=["file:///tmp/seed.json"],
        role_messages={"Referee": "first", "Checker": "second"},
        tool_policy={"mode": "ask", "allow": ["shell"], "write_roots": [str(tmp_path)]},
        budget={"max_tokens": 2000, "max_wall_clock_s": 120},
        deadline="2026-02-14T00:00:00Z",
    )

    assert result["status"] == "ok"
    assert len(runtime.calls) == 2
    checker_inputs = runtime.calls[1]["input_artifacts"]
    assert "file:///tmp/referee-review.json" in checker_inputs
