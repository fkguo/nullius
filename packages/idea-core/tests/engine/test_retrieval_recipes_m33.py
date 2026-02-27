from __future__ import annotations

import json
from pathlib import Path

from jsonschema.validators import Draft202012Validator

from idea_core.contracts.validate import DEFAULT_CONTRACT_DIR
from idea_core.engine.coordinator import IdeaCoreService


def make_service(tmp_path: Path) -> IdeaCoreService:
    return IdeaCoreService(data_dir=tmp_path / "runs", contract_dir=DEFAULT_CONTRACT_DIR)


def init_campaign(service: IdeaCoreService) -> str:
    result = service.handle(
        "campaign.init",
        {
            "charter": {
                "campaign_name": "m3.3-librarian-fixture",
                "domain": "hep-ph",
                "scope": "m3.3 retrieval recipes fixture",
                "approval_gate_ref": "gate://a0.1",
                "extensions": {
                    "domain_pack_id": "hep.operators.v1",
                    "initial_island_count": 3,
                },
            },
            "seed_pack": {
                "seeds": [
                    {"seed_type": "text", "content": "lepton-flavor anomaly in semileptonic decays"},
                    {"seed_type": "text", "content": "symmetry-constrained EFT operator basis"},
                    {"seed_type": "text", "content": "large-N limit tension in lattice extraction"},
                ]
            },
            "budget": {
                "max_tokens": 100000,
                "max_cost_usd": 100.0,
                "max_wall_clock_s": 100000,
                "max_steps": 30,
            },
            "idempotency_key": "m3.3-librarian-init",
        },
    )
    return result["campaign_id"]


def test_m3_3_librarian_recipes_emit_evidence_packets_and_claim_uris(tmp_path: Path) -> None:
    service = make_service(tmp_path)
    campaign_id = init_campaign(service)
    schema_path = (
        Path(__file__).resolve().parents[2]
        / "src"
        / "idea_core"
        / "engine"
        / "schemas"
        / "librarian_evidence_packet_v1.schema.json"
    )
    packet_schema = json.loads(schema_path.read_text(encoding="utf-8"))
    packet_validator = Draft202012Validator(packet_schema)

    step_result = service.handle(
        "search.step",
        {
            "campaign_id": campaign_id,
            "n_steps": 3,
            "idempotency_key": "m3.3-librarian-step",
        },
    )
    assert step_result["n_steps_executed"] == 3
    assert len(step_result["new_node_ids"]) == 3

    nodes_artifact = service.store.load_artifact_from_ref(step_result["new_nodes_artifact_ref"])
    operator_events = nodes_artifact["operator_events"]
    assert len(operator_events) == 3

    for event in operator_events:
        evidence_packet_ref = event["evidence_packet_ref"]
        packet = service.store.load_artifact_from_ref(evidence_packet_ref)
        packet_validator.validate(packet)
        assert packet["packet_type"] == "librarian_evidence_packet_v1"
        assert packet["packet_schema_version"] == 1
        assert packet["relevance_policy"] == "template_prior_v1"
        assert packet["operator_id"] == event["operator_id"]
        assert packet["island_id"] == event["island_id"]

        recipes = packet["recipes"]
        assert len(recipes) == 2
        assert [recipe["provider"] for recipe in recipes] == ["INSPIRE", "PDG"]

        packet_evidence_uris: list[str] = []
        for recipe in recipes:
            assert recipe["query_template"]
            assert recipe["query"]
            assert recipe["api_source"] in {"INSPIRE", "PDG"}
            assert recipe["api_query"] == recipe["query"]
            assert recipe["raw_response_hash"].startswith("sha256:")
            assert len(recipe["hits"]) >= 1
            for hit in recipe["hits"]:
                assert isinstance(hit["uri"], str) and hit["uri"].startswith("https://")
                assert isinstance(hit["summary"], str) and hit["summary"]
                assert hit["summary_source"] == "template"
                assert isinstance(hit["relevance"], float)
                assert 0.0 <= hit["relevance"] <= 1.0
                packet_evidence_uris.append(hit["uri"])

        node = service.handle(
            "node.get",
            {"campaign_id": campaign_id, "node_id": event["new_node_id"]},
        )
        claim_evidence_uris = node["idea_card"]["claims"][0]["evidence_uris"]
        assert evidence_packet_ref in claim_evidence_uris
        for uri in packet_evidence_uris:
            assert uri in claim_evidence_uris
