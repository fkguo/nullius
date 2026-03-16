from __future__ import annotations

from pathlib import Path

from idea_core.contracts.validate import DEFAULT_CONTRACT_DIR
from idea_core.engine.coordinator import IdeaCoreService, RpcError
from idea_core.engine.hep_constraint_policy import build_hep_constraint_findings
from idea_core.engine.hep_domain_pack import build_builtin_hep_domain_pack_index


def make_service(tmp_path: Path) -> IdeaCoreService:
    return IdeaCoreService(
        data_dir=tmp_path / "runs",
        contract_dir=DEFAULT_CONTRACT_DIR,
        domain_pack_index=build_builtin_hep_domain_pack_index(),
    )


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
    step_name: str | None = None,
    method: str,
    required_infrastructure: str | None,
    estimated_compute_hours_log10: float | None,
) -> None:
    nodes = service.store.load_nodes(campaign_id)
    node = nodes[node_id]
    step = node["idea_card"]["minimal_compute_plan"][0]
    if step_name is not None:
        step["step"] = step_name
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


def test_eval_run_preserves_missing_compute_capability_fields_without_hep_defaults(
    tmp_path: Path,
) -> None:
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

    eval_result = service.handle(
        "eval.run",
        {
            "campaign_id": campaign_id,
            "node_ids": [node_id],
            "evaluator_config": {"dimensions": ["feasibility", "grounding"], "n_reviewers": 2},
            "idempotency_key": "m3.6-eval-default-rubric",
        },
    )

    scorecards_payload = service.store.load_artifact_from_ref(eval_result["scorecards_artifact_ref"])
    failure_modes = scorecards_payload["scorecards"][0]["failure_modes"]
    node = service.handle("node.get", {"campaign_id": campaign_id, "node_id": node_id})
    step = node["idea_card"]["minimal_compute_plan"][0]
    assert "required_infrastructure" not in step
    assert "estimated_compute_hours_log10" not in step
    assert not any("required_infrastructure_below_rubric" in mode for mode in failure_modes)
    assert not any("estimated_compute_hours_below_rubric" in mode for mode in failure_modes)


def test_node_promote_blocks_explicitly_not_yet_feasible_compute_plan(tmp_path: Path) -> None:
    service = make_service(tmp_path)
    campaign_id, node_id = init_campaign(service)
    _set_compute_plan_step(
        service,
        campaign_id,
        node_id,
        method="staged numerical validation pipeline",
        required_infrastructure="not_yet_feasible",
        estimated_compute_hours_log10=4.0,
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
    assert any("required_infrastructure_not_yet_feasible" in mode for mode in failure_modes)

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
        assert any("required_infrastructure_not_yet_feasible" in mode for mode in blocking_modes)


def test_eval_run_records_compute_hours_infrastructure_mismatch(tmp_path: Path) -> None:
    service = make_service(tmp_path)
    campaign_id, node_id = init_campaign(service)
    _set_compute_plan_step(
        service,
        campaign_id,
        node_id,
        method="staged numerical validation pipeline",
        required_infrastructure="workstation",
        estimated_compute_hours_log10=3.5,
    )

    eval_result = service.handle(
        "eval.run",
        {
            "campaign_id": campaign_id,
            "node_ids": [node_id],
            "evaluator_config": {"dimensions": ["feasibility", "grounding"], "n_reviewers": 2},
            "idempotency_key": "m3.6-eval-infra-mismatch",
        },
    )

    scorecards_payload = service.store.load_artifact_from_ref(eval_result["scorecards_artifact_ref"])
    failure_modes = scorecards_payload["scorecards"][0]["failure_modes"]
    assert any("compute_hours_infrastructure_mismatch" in mode for mode in failure_modes)


def test_eval_run_records_placeholder_step_label(tmp_path: Path) -> None:
    service = make_service(tmp_path)
    campaign_id, node_id = init_campaign(service)
    _set_compute_plan_step(
        service,
        campaign_id,
        node_id,
        step_name="TBD",
        method="staged numerical validation pipeline",
        required_infrastructure="workstation",
        estimated_compute_hours_log10=1.0,
    )

    eval_result = service.handle(
        "eval.run",
        {
            "campaign_id": campaign_id,
            "node_ids": [node_id],
            "evaluator_config": {"dimensions": ["feasibility", "grounding"], "n_reviewers": 2},
            "idempotency_key": "m3.6-eval-placeholder-step",
        },
    )

    scorecards_payload = service.store.load_artifact_from_ref(eval_result["scorecards_artifact_ref"])
    failure_modes = scorecards_payload["scorecards"][0]["failure_modes"]
    assert any("compute_plan_placeholder_step" in mode for mode in failure_modes)


def test_compute_plan_findings_do_not_require_claims() -> None:
    findings = build_hep_constraint_findings(
        {
            "idea_card": {
                "claims": [],
                "minimal_compute_plan": [
                    {
                        "step": "TBD",
                        "method": "staged numerical validation pipeline",
                        "estimated_difficulty": "moderate",
                        "required_infrastructure": "not_yet_feasible",
                    }
                ],
            }
        }
    )

    codes = {finding["code"] for finding in findings}
    assert "compute_plan_placeholder_step" in codes
    assert "required_infrastructure_not_yet_feasible" in codes
