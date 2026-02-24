from __future__ import annotations

from pathlib import Path

from idea_core.contracts.validate import DEFAULT_CONTRACT_DIR
from idea_core.engine.service import IdeaCoreService


def make_service(tmp_path: Path) -> IdeaCoreService:
    return IdeaCoreService(data_dir=tmp_path / "runs", contract_dir=DEFAULT_CONTRACT_DIR)


def init_campaign(service: IdeaCoreService, *, extensions: dict) -> str:
    result = service.handle(
        "campaign.init",
        {
            "charter": {
                "campaign_name": "m3.2-operators-fixture",
                "domain": "hep-ph",
                "scope": "m3.2 operator family diversity fixture",
                "approval_gate_ref": "gate://a0.1",
                "extensions": extensions,
            },
            "seed_pack": {
                "seeds": [
                    {"seed_type": "text", "content": "seed-a"},
                    {"seed_type": "text", "content": "seed-b"},
                    {"seed_type": "text", "content": "seed-c"},
                ]
            },
            "budget": {
                "max_tokens": 100000,
                "max_cost_usd": 100.0,
                "max_wall_clock_s": 100000,
                "max_steps": 50,
            },
            "idempotency_key": "m3.2-operators-init",
        },
    )
    island_states = result["island_states"]
    assert len(island_states) == int(extensions["initial_island_count"])
    return result["campaign_id"]


def test_m3_2_operator_families_are_diverse_across_islands_and_survive_repopulation(
    tmp_path: Path,
) -> None:
    service = make_service(tmp_path)
    campaign_id = init_campaign(
        service,
        extensions={
            "domain_pack_id": "hep.operators.v1",
            "initial_island_count": 3,
        },
    )

    result = service.handle(
        "search.step",
        {
            "campaign_id": campaign_id,
            "n_steps": 12,
            "idempotency_key": "m3.2-operators-step",
        },
    )
    assert result["n_steps_executed"] == 12
    assert len(result["new_node_ids"]) == 12

    nodes_artifact = service.store.load_artifact_from_ref(result["new_nodes_artifact_ref"])
    operator_events = nodes_artifact["operator_events"]

    families_by_island: dict[str, set[str]] = {}
    for event in operator_events:
        island_id = event["island_id"]
        families_by_island.setdefault(island_id, set()).add(event["operator_family"])

    assert set(families_by_island.keys()) == {"island-0", "island-1", "island-2"}
    assert all(len(families) == 1 for families in families_by_island.values())
    assert {next(iter(families)) for families in families_by_island.values()} == {
        "AnomalyAbduction",
        "SymmetryOperator",
        "LimitExplorer",
    }

    step_ref = (
        service.store.artifact_path(campaign_id, "search_steps", f"{result['step_id']}.json")
        .resolve()
        .as_uri()
    )
    step_artifact = service.store.load_artifact_from_ref(step_ref)
    repopulated_islands = {
        event["island_id"]
        for event in step_artifact["transition_events"]
        if event.get("to_state") == "REPOPULATED"
    }
    assert repopulated_islands == {"island-0", "island-1", "island-2"}

