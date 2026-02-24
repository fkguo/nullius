from __future__ import annotations

from pathlib import Path

from idea_core.contracts.validate import DEFAULT_CONTRACT_DIR
from idea_core.engine.service import IdeaCoreService, RpcError


def make_service(tmp_path: Path) -> IdeaCoreService:
    return IdeaCoreService(data_dir=tmp_path / "runs", contract_dir=DEFAULT_CONTRACT_DIR)


def init_campaign(service: IdeaCoreService) -> tuple[str, str]:
    result = service.handle(
        "campaign.init",
        {
            "charter": {
                "campaign_name": "m3.5-hep-constraints",
                "domain": "hep-ph",
                "scope": "m3.5 hep constraints fixture",
                "approval_gate_ref": "gate://a0.1",
            },
            "seed_pack": {
                "seeds": [
                    {
                        "seed_type": "text",
                        "content": "seed-hep-constraints",
                        "source_uris": ["https://example.org/hep-seed"],
                    }
                ]
            },
            "budget": {
                "max_tokens": 100000,
                "max_cost_usd": 100.0,
                "max_wall_clock_s": 100000,
                "max_steps": 100,
            },
            "idempotency_key": "m3.5-init",
        },
    )
    campaign_id = result["campaign_id"]
    node_id = next(iter(service.store.load_nodes(campaign_id).keys()))
    return campaign_id, node_id


def _inject_hep_constraint_failures(service: IdeaCoreService, campaign_id: str, node_id: str) -> None:
    nodes = service.store.load_nodes(campaign_id)
    node = nodes[node_id]
    idea_card = node["idea_card"]
    idea_card["claims"][0][
        "claim_text"
    ] = "Massless mediator mass 5 GeV predicts branching ratio = 1.2 after full detector simulation."
    idea_card["minimal_compute_plan"][0]["method"] = "TBD: detector simulation + lattice scan"
    idea_card["minimal_compute_plan"][0]["required_infrastructure"] = "laptop"
    idea_card["minimal_compute_plan"][0]["estimated_compute_hours_log10"] = 4.2
    service.store.save_nodes(campaign_id, nodes)


def test_eval_run_emits_structured_hep_failure_modes_and_fix_suggestions(tmp_path: Path) -> None:
    service = make_service(tmp_path)
    campaign_id, node_id = init_campaign(service)
    _inject_hep_constraint_failures(service, campaign_id, node_id)

    eval_result = service.handle(
        "eval.run",
        {
            "campaign_id": campaign_id,
            "node_ids": [node_id],
            "evaluator_config": {"dimensions": ["feasibility", "grounding"], "n_reviewers": 2},
            "idempotency_key": "m3.5-eval",
        },
    )
    scorecards_payload = service.store.load_artifact_from_ref(eval_result["scorecards_artifact_ref"])
    scorecard = scorecards_payload["scorecards"][0]

    hep_failure_modes = [mode for mode in scorecard["failure_modes"] if mode.startswith("hep:")]
    assert hep_failure_modes
    assert all(len(mode.split(":")) >= 5 for mode in hep_failure_modes)

    classes = {mode.split(":")[1] for mode in hep_failure_modes}
    assert "consistency" in classes
    assert "feasibility" in classes
    assert any(mode.endswith(":critical") for mode in hep_failure_modes)

    fix_failure_modes = {item["failure_mode"] for item in scorecard["fix_suggestions"]}
    assert "physics_inconsistency" in fix_failure_modes
    assert "not_computable" in fix_failure_modes

    node = service.handle("node.get", {"campaign_id": campaign_id, "node_id": node_id})
    assert node["eval_info"]["failure_modes"] == scorecard["failure_modes"]


def test_node_promote_fails_on_blocking_hep_constraint_failure_modes(tmp_path: Path) -> None:
    service = make_service(tmp_path)
    campaign_id, node_id = init_campaign(service)
    _inject_hep_constraint_failures(service, campaign_id, node_id)

    service.handle(
        "eval.run",
        {
            "campaign_id": campaign_id,
            "node_ids": [node_id],
            "evaluator_config": {"dimensions": ["feasibility", "grounding"], "n_reviewers": 2},
            "idempotency_key": "m3.5-eval-promote-gate",
        },
    )

    try:
        service.handle(
            "node.promote",
            {
                "campaign_id": campaign_id,
                "node_id": node_id,
                "idempotency_key": "m3.5-promote",
            },
        )
        assert False, "expected RpcError"
    except RpcError as exc:
        assert exc.code == -32002
        assert exc.message == "schema_validation_failed"
        assert exc.data["reason"] == "schema_invalid"
        assert exc.data["details"]["message"] == "hep_constraints_failed"
        blocking_modes = exc.data["details"]["blocking_failure_modes"]
        assert blocking_modes
        assert all(mode.startswith("hep:") for mode in blocking_modes)
        assert all(mode.endswith(":critical") for mode in blocking_modes)

