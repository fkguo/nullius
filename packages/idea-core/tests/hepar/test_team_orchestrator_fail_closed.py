from __future__ import annotations

from pathlib import Path

from idea_core.engine.store import EngineStore
from idea_core.hepar.control_plane import HeparControlPlaneStore, TeamPlan
from idea_core.hepar.orchestrator import TeamRoleOrchestrator


class _ExplodingRuntimeExecutor:
    def execute_work_order(self, work_order, *, role_message: str):
        raise ValueError(f"boom:{work_order.role_id}:{role_message}")


def test_team_orchestrator_converts_executor_bug_to_failed_result(tmp_path: Path) -> None:
    control_store = HeparControlPlaneStore(root_dir=tmp_path / "hepar")
    idea_store = EngineStore(root_dir=tmp_path / "idea_store")
    orchestrator = TeamRoleOrchestrator(
        control_plane_store=control_store,
        runtime_executor=_ExplodingRuntimeExecutor(),
        idea_store=idea_store,
    )
    team_plan = TeamPlan(
        team_id="team-fail-closed",
        coordination_policy="sequential",
        roles=[{"role_id": "Referee"}],
        merge_policy={"strategy": "sequential"},
        clean_room=True,
    )

    result = orchestrator.run_team_plan(
        team_plan=team_plan,
        campaign_id="campaign-44",
        idea_id="idea-44",
        island_id="island-0",
        node_id="node-44",
        input_artifacts=["file:///tmp/seed.json"],
        role_messages={"Referee": "run referee"},
        tool_policy={"mode": "ask", "allow": ["shell"], "write_roots": [str(tmp_path)]},
        budget={"max_tokens": 2000, "max_wall_clock_s": 120},
        deadline="2026-02-14T00:00:00Z",
    )

    assert result["status"] == "failed"
    assert result["role_results"][0]["status"] == "failed"
    assert result["role_results"][0]["summary"] == "ValueError: boom:Referee:run referee"

    events = control_store.read_ledger_events()
    role_failed = [event for event in events if event["event_type"] == "team_orchestration.role_failed"]
    assert len(role_failed) == 1
    assert role_failed[0]["error_type"] == "ValueError"
