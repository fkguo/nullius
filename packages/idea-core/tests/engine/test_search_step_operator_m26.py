from __future__ import annotations

from pathlib import Path

from idea_core.contracts.validate import DEFAULT_CONTRACT_DIR
from idea_core.engine.coordinator import IdeaCoreService, RpcError


def make_service(tmp_path: Path) -> IdeaCoreService:
    return IdeaCoreService(data_dir=tmp_path / "runs", contract_dir=DEFAULT_CONTRACT_DIR)


def init_campaign(
    service: IdeaCoreService,
    *,
    max_steps: int = 20,
    max_nodes: int | None = None,
) -> str:
    budget = {
        "max_tokens": 100000,
        "max_cost_usd": 100.0,
        "max_wall_clock_s": 100000,
        "max_steps": max_steps,
    }
    if max_nodes is not None:
        budget["max_nodes"] = max_nodes

    result = service.handle(
        "campaign.init",
        {
            "charter": {
                "campaign_name": "m2.6-operator-fixture",
                "domain": "hep-ph",
                "scope": "m2.6 operator loop fixture",
                "approval_gate_ref": "gate://a0.1",
            },
            "seed_pack": {
                "seeds": [
                    {"seed_type": "text", "content": "seed-a"},
                    {"seed_type": "text", "content": "seed-b"},
                ]
            },
            "budget": budget,
            "idempotency_key": f"init-max-steps-{max_steps}-max-nodes-{max_nodes}",
        },
    )
    return result["campaign_id"]


def test_search_step_round_robin_uses_two_dummy_operators_with_auditable_trace(tmp_path: Path) -> None:
    service = make_service(tmp_path)
    campaign_id = init_campaign(service, max_steps=20)

    result = service.handle(
        "search.step",
        {
            "campaign_id": campaign_id,
            "n_steps": 4,
            "idempotency_key": "search-operators-round-robin",
        },
    )
    assert result["n_steps_executed"] == 4
    assert len(result["new_node_ids"]) == 4
    assert result["new_nodes_artifact_ref"].startswith("file://")

    artifact = service.store.load_artifact_from_ref(result["new_nodes_artifact_ref"])
    operator_events = artifact["operator_events"]
    assert [event["operator_id"] for event in operator_events] == [
        "dummy.expand.bridge",
        "dummy.constraint.shift",
        "dummy.expand.bridge",
        "dummy.constraint.shift",
    ]
    assert {event["backend_id"] for event in operator_events} == {
        "dummy.backend.alpha",
        "dummy.backend.beta",
    }
    for event in operator_events:
        assert event["island_id"] == "island-0"
        assert event["new_node_id"] in result["new_node_ids"]
        trace_payload = service.store.load_artifact_from_ref(event["operator_trace_artifact_ref"])
        assert trace_payload["operator_id"] == event["operator_id"]
        assert trace_payload["backend_id"] == event["backend_id"]
        assert trace_payload["island_id"] == event["island_id"]

    # Determinism check: operator schedule is stable across campaigns.
    service_2 = make_service(tmp_path / "second")
    campaign_id_2 = init_campaign(service_2, max_steps=20)
    result_2 = service_2.handle(
        "search.step",
        {
            "campaign_id": campaign_id_2,
            "n_steps": 4,
            "idempotency_key": "search-operators-round-robin",
        },
    )
    artifact_2 = service_2.store.load_artifact_from_ref(result_2["new_nodes_artifact_ref"])
    assert [event["operator_id"] for event in artifact_2["operator_events"]] == [
        "dummy.expand.bridge",
        "dummy.constraint.shift",
        "dummy.expand.bridge",
        "dummy.constraint.shift",
    ]


def test_generated_nodes_visible_via_node_list_cursor_and_node_get(tmp_path: Path) -> None:
    service = make_service(tmp_path)
    campaign_id = init_campaign(service, max_steps=20)
    result = service.handle(
        "search.step",
        {
            "campaign_id": campaign_id,
            "n_steps": 2,
            "idempotency_key": "search-node-visibility",
        },
    )
    new_node_ids = result["new_node_ids"]
    assert len(new_node_ids) == 2

    cursor = None
    seen_node_ids: list[str] = []
    while True:
        params = {"campaign_id": campaign_id, "limit": 2}
        if cursor is not None:
            params["cursor"] = cursor
        page = service.handle("node.list", params)
        seen_node_ids.extend(node["node_id"] for node in page["nodes"])
        cursor = page["cursor"]
        if cursor is None:
            break

    assert set(new_node_ids).issubset(set(seen_node_ids))
    assert len(seen_node_ids) == 4

    for node_id in new_node_ids:
        node = service.handle("node.get", {"campaign_id": campaign_id, "node_id": node_id})
        assert node["operator_id"] in {"dummy.expand.bridge", "dummy.constraint.shift"}
        assert len(node["parent_node_ids"]) == 1
        assert node["idea_card"] is not None
        assert node["idea_card"]["thesis_statement"].startswith(node["rationale_draft"]["title"])
        assert "candidate_formalisms" not in node["idea_card"]
        formalization = node["operator_trace"]["params"]["formalization"]
        assert formalization["mode"] == "explain_then_formalize_deterministic_v1"
        assert formalization["source_artifact"] == "rationale_draft"
        assert formalization["rationale_hash"].startswith("sha256:")


def test_search_step_step_budget_max_nodes_early_stop_counts_steps_and_nodes(tmp_path: Path) -> None:
    service = make_service(tmp_path)
    campaign_id = init_campaign(service, max_steps=20)

    result = service.handle(
        "search.step",
        {
            "campaign_id": campaign_id,
            "n_steps": 5,
            "step_budget": {"max_nodes": 1},
            "idempotency_key": "search-step-budget-max-nodes",
        },
    )
    assert result["n_steps_executed"] == 1
    assert result["early_stopped"] is True
    assert result["early_stop_reason"] == "step_budget_exhausted"
    assert result["budget_snapshot"]["steps_used"] == 1
    assert result["budget_snapshot"]["nodes_used"] == 3

    status = service.handle("campaign.status", {"campaign_id": campaign_id})
    assert status["status"] == "running"
    assert status["budget_snapshot"]["steps_used"] == 1
    assert status["budget_snapshot"]["nodes_used"] == 3


def test_search_step_idempotency_replay_and_conflict(tmp_path: Path) -> None:
    service = make_service(tmp_path)
    campaign_id = init_campaign(service, max_steps=20)
    params = {
        "campaign_id": campaign_id,
        "n_steps": 2,
        "idempotency_key": "search-idempotency-key",
    }

    first = service.handle("search.step", params)
    second = service.handle("search.step", params)

    assert first["step_id"] == second["step_id"]
    assert first["new_node_ids"] == second["new_node_ids"]
    assert first["idempotency"]["is_replay"] is False
    assert second["idempotency"]["is_replay"] is True

    status = service.handle("campaign.status", {"campaign_id": campaign_id})
    assert status["budget_snapshot"]["steps_used"] == 2
    assert status["budget_snapshot"]["nodes_used"] == 4

    try:
        service.handle(
            "search.step",
            {
                "campaign_id": campaign_id,
                "n_steps": 1,
                "idempotency_key": "search-idempotency-key",
            },
        )
        assert False, "expected RpcError"
    except RpcError as exc:
        assert exc.code == -32002
        assert exc.data["reason"] == "idempotency_key_conflict"
        assert exc.data["idempotency_key"] == "search-idempotency-key"
        assert exc.data["payload_hash"].startswith("sha256:")


def test_search_step_nodes_flow_into_eval_rank_promote_smoke(tmp_path: Path) -> None:
    service = make_service(tmp_path)
    campaign_id = init_campaign(service, max_steps=20)

    step_result = service.handle(
        "search.step",
        {
            "campaign_id": campaign_id,
            "n_steps": 1,
            "idempotency_key": "search-smoke",
        },
    )
    node_id = step_result["new_node_ids"][0]

    eval_result = service.handle(
        "eval.run",
        {
            "campaign_id": campaign_id,
            "node_ids": [node_id],
            "evaluator_config": {"dimensions": ["novelty", "impact", "grounding"], "n_reviewers": 2},
            "idempotency_key": "eval-smoke",
        },
    )
    assert eval_result["updated_node_ids"] == [node_id]

    rank_result = service.handle(
        "rank.compute",
        {
            "campaign_id": campaign_id,
            "method": "pareto",
            "dimensions": ["novelty", "impact"],
            "idempotency_key": "rank-smoke",
        },
    )
    assert rank_result["ranked_nodes"][0]["node_id"] == node_id

    promote_result = service.handle(
        "node.promote",
        {
            "campaign_id": campaign_id,
            "node_id": node_id,
            "idempotency_key": "promote-smoke",
        },
    )
    assert promote_result["node_id"] == node_id
    handoff = service.store.load_artifact_from_ref(promote_result["handoff_artifact_ref"])
    assert handoff["campaign_id"] == campaign_id
    assert handoff["node_id"] == node_id
