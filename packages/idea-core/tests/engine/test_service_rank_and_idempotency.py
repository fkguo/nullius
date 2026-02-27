from __future__ import annotations

import json
from pathlib import Path
from uuid import uuid4

from idea_core.contracts.validate import DEFAULT_CONTRACT_DIR
from idea_core.engine.coordinator import IdeaCoreService, RpcError


def make_service(tmp_path: Path) -> IdeaCoreService:
    return IdeaCoreService(data_dir=tmp_path / "runs", contract_dir=DEFAULT_CONTRACT_DIR)


def init_campaign(service: IdeaCoreService) -> dict:
    return service.handle(
        "campaign.init",
        {
            "charter": {
                "campaign_name": "rank-fixture",
                "domain": "hep-ph",
                "scope": "bootstrap campaign scope text",
                "approval_gate_ref": "gate://a0.1",
            },
            "seed_pack": {
                "seeds": [
                    {"seed_type": "text", "content": "seed-one", "source_uris": ["https://example.org/1"]},
                    {"seed_type": "text", "content": "seed-two", "source_uris": ["https://example.org/2"]},
                ]
            },
            "budget": {
                "max_tokens": 100000,
                "max_cost_usd": 100.0,
                "max_wall_clock_s": 100000,
                "max_steps": 100,
                "max_nodes": 100,
            },
            "idempotency_key": "init-key",
        },
    )


def test_rank_compute_failure_priority_order(tmp_path: Path) -> None:
    service = make_service(tmp_path)
    init_result = init_campaign(service)
    campaign_id = init_result["campaign_id"]

    # Case 1: no_scorecards takes highest priority.
    try:
        service.handle(
            "rank.compute",
            {
                "campaign_id": campaign_id,
                "method": "pareto",
                "idempotency_key": "rank-noscorecards",
            },
        )
        assert False, "expected RpcError"
    except RpcError as exc:
        assert exc.code == -32013
        assert exc.data["reason"] == "no_scorecards"

    # Run eval with one dimension so observed_keys exists but <2 dimensions for pareto.
    nodes = list(service.store.load_nodes(campaign_id).keys())
    service.handle(
        "eval.run",
        {
            "campaign_id": campaign_id,
            "node_ids": [nodes[0]],
            "evaluator_config": {"dimensions": ["novelty"], "n_reviewers": 2},
            "idempotency_key": "eval-1d",
        },
    )

    # Case 2: insufficient_dimensions is checked before insufficient_nodes (pareto path).
    try:
        service.handle(
            "rank.compute",
            {
                "campaign_id": campaign_id,
                "method": "pareto",
                "idempotency_key": "rank-dims",
            },
        )
        assert False, "expected RpcError"
    except RpcError as exc:
        assert exc.code == -32013
        assert exc.data["reason"] == "insufficient_dimensions"

    # Refresh scorecards with >=2 dimensions but keep one node for ELO to trigger insufficient_nodes.
    service.handle(
        "eval.run",
        {
            "campaign_id": campaign_id,
            "node_ids": [nodes[0]],
            "evaluator_config": {"dimensions": ["novelty", "impact"], "n_reviewers": 2},
            "idempotency_key": "eval-2d",
        },
    )

    try:
        service.handle(
            "rank.compute",
            {
                "campaign_id": campaign_id,
                "method": "elo",
                "elo_config": {"max_rounds": 3, "seed": 7},
                "idempotency_key": "rank-elo-1node",
            },
        )
        assert False, "expected RpcError"
    except RpcError as exc:
        assert exc.code == -32013
        assert exc.data["reason"] == "insufficient_nodes"


def test_rank_compute_ignores_failed_scorecards(tmp_path: Path) -> None:
    service = make_service(tmp_path)
    init_result = init_campaign(service)
    campaign_id = init_result["campaign_id"]
    node_ids = list(service.store.load_nodes(campaign_id).keys())

    eval_result = service.handle(
        "eval.run",
        {
            "campaign_id": campaign_id,
            "node_ids": node_ids,
            "evaluator_config": {"dimensions": ["novelty", "impact"], "n_reviewers": 2},
            "idempotency_key": "eval-two",
        },
    )

    scorecards = service.store.load_artifact_from_ref(eval_result["scorecards_artifact_ref"])
    scorecards["scorecards"][0]["status"] = "failed"
    scorecards["scorecards"][0]["scores"] = {}
    scorecards["scorecards"][0]["failure_modes"] = ["tool timeout"]

    scorecards_path = Path(eval_result["scorecards_artifact_ref"][7:])
    scorecards_path.write_text(json.dumps(scorecards, indent=2), encoding="utf-8")

    rank_result = service.handle(
        "rank.compute",
        {
            "campaign_id": campaign_id,
            "method": "pareto",
            "idempotency_key": "rank-ignore-failed",
        },
    )

    assert set(rank_result["effective_dimensions"]) == {"novelty", "impact"}
    assert rank_result["ranked_nodes"]
    assert all(item["node_id"] != node_ids[0] for item in rank_result["ranked_nodes"])


def test_idempotency_key_conflict_includes_payload_hash_and_key(tmp_path: Path) -> None:
    service = make_service(tmp_path)

    service.handle(
        "campaign.init",
        {
            "charter": {
                "campaign_name": "idempotency",
                "domain": "hep-ph",
                "scope": "idempotency contract fixture text",
                "approval_gate_ref": "gate://a0.1",
            },
            "seed_pack": {"seeds": [{"seed_type": "text", "content": "seed-a"}]},
            "budget": {
                "max_tokens": 100000,
                "max_cost_usd": 100.0,
                "max_wall_clock_s": 100000,
            },
            "idempotency_key": "dup-key",
        },
    )

    try:
        service.handle(
            "campaign.init",
            {
                "charter": {
                    "campaign_name": "idempotency",
                    "domain": "hep-ph",
                    "scope": "DIFFERENT scope to force payload mismatch",
                    "approval_gate_ref": "gate://a0.1",
                },
                "seed_pack": {"seeds": [{"seed_type": "text", "content": "seed-a"}]},
                "budget": {
                    "max_tokens": 100000,
                    "max_cost_usd": 100.0,
                    "max_wall_clock_s": 100000,
                },
                "idempotency_key": "dup-key",
            },
        )
        assert False, "expected RpcError"
    except RpcError as exc:
        assert exc.code == -32002
        assert exc.data["reason"] == "idempotency_key_conflict"
        assert exc.data["idempotency_key"] == "dup-key"
        assert exc.data["payload_hash"].startswith("sha256:")
        assert len(exc.data["payload_hash"]) == 71


def test_idempotency_replay_returns_same_response_with_is_replay_true(tmp_path: Path) -> None:
    service = make_service(tmp_path)
    init_result = init_campaign(service)
    campaign_id = init_result["campaign_id"]
    node_id = next(iter(service.store.load_nodes(campaign_id).keys()))

    first = service.handle(
        "eval.run",
        {
            "campaign_id": campaign_id,
            "node_ids": [node_id],
            "evaluator_config": {"dimensions": ["novelty", "grounding"], "n_reviewers": 2},
            "idempotency_key": "eval-replay-key",
        },
    )
    second = service.handle(
        "eval.run",
        {
            "campaign_id": campaign_id,
            "node_ids": [node_id],
            "evaluator_config": {"dimensions": ["novelty", "grounding"], "n_reviewers": 2},
            "idempotency_key": "eval-replay-key",
        },
    )

    assert first["scorecards_artifact_ref"] == second["scorecards_artifact_ref"]
    assert first["idempotency"]["is_replay"] is False
    assert second["idempotency"]["is_replay"] is True
    assert first["idempotency"]["payload_hash"] == second["idempotency"]["payload_hash"]


def test_payload_hash_fills_method_defaults_before_hashing(tmp_path: Path) -> None:
    service = make_service(tmp_path)
    campaign_id = str(uuid4())
    h1 = service._hash_without_idempotency(
        "node.list",
        {
            "campaign_id": campaign_id,
            "idempotency_key": "unused",
        },
    )
    h2 = service._hash_without_idempotency(
        "node.list",
        {
            "campaign_id": campaign_id,
            "limit": 50,
            "idempotency_key": "unused",
        },
    )
    assert h1 == h2


def test_eval_run_rejects_node_not_in_campaign(tmp_path: Path) -> None:
    service = make_service(tmp_path)
    init_result = init_campaign(service)
    campaign_id = init_result["campaign_id"]
    nodes = service.store.load_nodes(campaign_id)
    node_id = next(iter(nodes))

    nodes[node_id]["campaign_id"] = "00000000-0000-4000-8000-000000000000"
    service.store.save_nodes(campaign_id, nodes)

    try:
        service.handle(
            "eval.run",
            {
                "campaign_id": campaign_id,
                "node_ids": [node_id],
                "evaluator_config": {"dimensions": ["novelty"], "n_reviewers": 2},
                "idempotency_key": "eval-node-wrong-campaign",
            },
        )
        assert False, "expected RpcError"
    except RpcError as exc:
        assert exc.code == -32014
        assert exc.data["reason"] == "node_not_in_campaign"
        assert exc.data["campaign_id"] == campaign_id
        assert exc.data["node_id"] == node_id


def test_unimplemented_method_returns_method_not_implemented_error(tmp_path: Path) -> None:
    service = make_service(tmp_path)
    campaign_id = str(uuid4())

    try:
        service.handle(
            "campaign.pause",
            {
                "campaign_id": campaign_id,
                "idempotency_key": "campaign-pause-stub",
            },
        )
        assert False, "expected RpcError"
    except RpcError as exc:
        assert exc.code == -32000
        assert exc.message == "method_not_implemented"
        assert exc.data["reason"] == "method_not_implemented"
        assert exc.data["details"]["method"] == "campaign.pause"
