from __future__ import annotations

from pathlib import Path

from idea_core.contracts.validate import DEFAULT_CONTRACT_DIR
from idea_core.engine.coordinator import IdeaCoreService, RpcError


def make_service(tmp_path: Path) -> IdeaCoreService:
    return IdeaCoreService(data_dir=tmp_path / "runs", contract_dir=DEFAULT_CONTRACT_DIR)


def init_campaign(service: IdeaCoreService) -> str:
    result = service.handle(
        "campaign.init",
        {
            "charter": {
                "campaign_name": "node-read-fixture",
                "domain": "hep-ph",
                "scope": "node read fixture scope",
                "approval_gate_ref": "gate://a0.1",
            },
            "seed_pack": {
                "seeds": [
                    {"seed_type": "text", "content": "seed-a"},
                    {"seed_type": "text", "content": "seed-b"},
                ]
            },
            "budget": {
                "max_tokens": 100000,
                "max_cost_usd": 100.0,
                "max_wall_clock_s": 100000,
            },
            "idempotency_key": "init-node-read",
        },
    )
    return result["campaign_id"]


def test_node_list_and_get_happy_path(tmp_path: Path) -> None:
    service = make_service(tmp_path)
    campaign_id = init_campaign(service)

    list_result = service.handle(
        "node.list",
        {
            "campaign_id": campaign_id,
            "limit": 1,
        },
    )
    assert list_result["campaign_id"] == campaign_id
    assert list_result["total_count"] == 2
    assert len(list_result["nodes"]) == 1
    assert isinstance(list_result["cursor"], str)

    next_result = service.handle(
        "node.list",
        {
            "campaign_id": campaign_id,
            "limit": 1,
            "cursor": list_result["cursor"],
        },
    )
    assert len(next_result["nodes"]) == 1
    assert next_result["cursor"] is None

    node_id = list_result["nodes"][0]["node_id"]
    node = service.handle(
        "node.get",
        {
            "campaign_id": campaign_id,
            "node_id": node_id,
        },
    )
    assert node["node_id"] == node_id


def test_node_get_not_found(tmp_path: Path) -> None:
    service = make_service(tmp_path)
    campaign_id = init_campaign(service)

    try:
        service.handle(
            "node.get",
            {
                "campaign_id": campaign_id,
                "node_id": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            },
        )
        assert False, "expected RpcError"
    except RpcError as exc:
        assert exc.code == -32004
        assert exc.data["reason"] == "node_not_found"
