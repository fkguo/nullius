from __future__ import annotations

from pathlib import Path

from idea_core.contracts.validate import DEFAULT_CONTRACT_DIR
from idea_core.engine.coordinator import IdeaCoreService, RpcError


def make_service(tmp_path: Path) -> IdeaCoreService:
    return IdeaCoreService(data_dir=tmp_path / "runs", contract_dir=DEFAULT_CONTRACT_DIR)


def init_campaign(service: IdeaCoreService) -> tuple[str, str]:
    result = service.handle(
        "campaign.init",
        {
            "charter": {
                "campaign_name": "m3.6-compute-rubric",
                "domain": "hep-ph",
                "scope": "m3.6 compute rubric fixture",
                "approval_gate_ref": "gate://a0.1",
            },
            "seed_pack": {
                "seeds": [
                    {
                        "seed_type": "text",
                        "content": "seed-m3.6-hep-compute-rubric",
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
            "idempotency_key": "m3.6-init",
        },
    )
    campaign_id = result["campaign_id"]
    node_id = next(iter(service.store.load_nodes(campaign_id).keys()))
    return campaign_id, node_id


def _set_compute_plan_step(
    service: IdeaCoreService,
    campaign_id: str,
    node_id: str,
    *,
    method: str,
    required_infrastructure: str | None,
    estimated_compute_hours_log10: float | None,
) -> None:
    nodes = service.store.load_nodes(campaign_id)
    node = nodes[node_id]
    step = node["idea_card"]["minimal_compute_plan"][0]
    step["method"] = method
    if required_infrastructure is None:
        step.pop("required_infrastructure", None)
    else:
        step["required_infrastructure"] = required_infrastructure
    if estimated_compute_hours_log10 is None:
        step.pop("estimated_compute_hours_log10", None)
    else:
        step["estimated_compute_hours_log10"] = estimated_compute_hours_log10
    service.store.save_nodes(campaign_id, nodes)


def test_eval_run_applies_hep_default_rubric_for_missing_compute_fields(tmp_path: Path) -> None:
    service = make_service(tmp_path)
    campaign_id, node_id = init_campaign(service)
    _set_compute_plan_step(
        service,
        campaign_id,
        node_id,
        method="detector simulation with lattice Monte Carlo chain",
        required_infrastructure=None,
        estimated_compute_hours_log10=None,
    )

    service.handle(
        "eval.run",
        {
            "campaign_id": campaign_id,
            "node_ids": [node_id],
            "evaluator_config": {"dimensions": ["feasibility", "grounding"], "n_reviewers": 2},
            "idempotency_key": "m3.6-eval-default-rubric",
        },
    )

    node = service.handle("node.get", {"campaign_id": campaign_id, "node_id": node_id})
    step = node["idea_card"]["minimal_compute_plan"][0]
    assert step["required_infrastructure"] == "cluster"
    assert step["estimated_compute_hours_log10"] >= 3.0


def test_node_promote_blocks_underestimated_heavy_compute_plan(tmp_path: Path) -> None:
    service = make_service(tmp_path)
    campaign_id, node_id = init_campaign(service)
    _set_compute_plan_step(
        service,
        campaign_id,
        node_id,
        method="detector simulation with lattice Monte Carlo chain",
        required_infrastructure="workstation",
        estimated_compute_hours_log10=1.0,
    )

    eval_result = service.handle(
        "eval.run",
        {
            "campaign_id": campaign_id,
            "node_ids": [node_id],
            "evaluator_config": {"dimensions": ["feasibility", "grounding"], "n_reviewers": 2},
            "idempotency_key": "m3.6-eval-underestimate",
        },
    )

    scorecards_payload = service.store.load_artifact_from_ref(eval_result["scorecards_artifact_ref"])
    failure_modes = scorecards_payload["scorecards"][0]["failure_modes"]
    assert any("required_infrastructure_below_rubric" in mode for mode in failure_modes)
    assert any("estimated_compute_hours_below_rubric" in mode for mode in failure_modes)

    try:
        service.handle(
            "node.promote",
            {
                "campaign_id": campaign_id,
                "node_id": node_id,
                "idempotency_key": "m3.6-promote-blocked",
            },
        )
        assert False, "expected RpcError"
    except RpcError as exc:
        assert exc.code == -32002
        assert exc.message == "schema_validation_failed"
        assert exc.data["details"]["message"] == "hep_constraints_failed"
        blocking_modes = exc.data["details"]["blocking_failure_modes"]
        assert any("required_infrastructure_below_rubric" in mode for mode in blocking_modes)
        assert any("estimated_compute_hours_below_rubric" in mode for mode in blocking_modes)
