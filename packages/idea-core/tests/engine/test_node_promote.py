from __future__ import annotations

import json
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
                "campaign_name": "promote-fixture",
                "domain": "hep-ph",
                "scope": "promotion fixture scope",
                "approval_gate_ref": "gate://a0.1",
            },
            "seed_pack": {
                "seeds": [{"seed_type": "text", "content": "seed-promote", "source_uris": ["https://example.org/1"]}]
            },
            "budget": {
                "max_tokens": 100000,
                "max_cost_usd": 100.0,
                "max_wall_clock_s": 100000,
                "max_steps": 100,
            },
            "idempotency_key": "init-promote",
        },
    )
    campaign_id = result["campaign_id"]
    node_id = next(iter(service.store.load_nodes(campaign_id).keys()))
    return campaign_id, node_id


def _enable_grounding_pass(service: IdeaCoreService, campaign_id: str, node_id: str) -> None:
    service.handle(
        "eval.run",
        {
            "campaign_id": campaign_id,
            "node_ids": [node_id],
            "evaluator_config": {"dimensions": ["novelty", "grounding"], "n_reviewers": 2},
            "idempotency_key": f"eval-{node_id}",
        },
    )


def _mutate_node(service: IdeaCoreService, campaign_id: str, node_id: str, updates: dict) -> None:
    nodes = service.store.load_nodes(campaign_id)
    nodes[node_id].update(updates)
    service.store.save_nodes(campaign_id, nodes)


def _node_log_entries(service: IdeaCoreService, campaign_id: str) -> list[dict]:
    path = service.store.nodes_log_path(campaign_id)
    if not path.exists():
        return []
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]


def _valid_reduction_report() -> dict:
    mapping_row = {"source": "x", "target": "y", "mapping": "x->y"}
    return {
        "abstract_problem": "optimization",
        "reduction_map": [mapping_row, mapping_row, mapping_row, mapping_row, mapping_row, mapping_row, mapping_row, mapping_row],
        "assumptions_and_limits": [{"assumption_id": "a1", "statement": "valid domain"}],
        "known_solutions": [
            {
                "name": "solver-a",
                "prerequisites": ["p1"],
                "failure_modes": ["f1"],
                "reference_uris": ["https://example.org/sol-a"],
            },
            {
                "name": "solver-b",
                "prerequisites": ["p1"],
                "failure_modes": ["f1"],
                "reference_uris": ["https://example.org/sol-b"],
            },
        ],
        "transfer_plan": [
            {
                "step": "apply",
                "expected_output": "toy output",
                "acceptance": "matches expectation",
            }
        ],
        "minimal_toy_check": {
            "setup": "toy setup",
            "expected_result": "toy expected",
            "pass_fail_criteria": "difference < eps",
        },
        "kill_criteria": ["fails toy check"],
        "compatibility_checks": ["dimensional consistency", "symmetry preserved"],
    }


def test_node_promote_success_without_reduction(tmp_path: Path) -> None:
    service = make_service(tmp_path)
    campaign_id, node_id = init_campaign(service)
    _enable_grounding_pass(service, campaign_id, node_id)

    result = service.handle(
        "node.promote",
        {
            "campaign_id": campaign_id,
            "node_id": node_id,
            "idempotency_key": "promote-success-no-reduction",
        },
    )

    assert result["node_id"] == node_id
    assert result["has_reduction_report"] is False
    assert result["reduction_audit_summary"] is None


def test_node_promote_fails_grounding_not_pass(tmp_path: Path) -> None:
    service = make_service(tmp_path)
    campaign_id, node_id = init_campaign(service)

    try:
        service.handle(
            "node.promote",
            {
                "campaign_id": campaign_id,
                "node_id": node_id,
                "idempotency_key": "promote-grounding-fail",
            },
        )
        assert False, "expected RpcError"
    except RpcError as exc:
        assert exc.code == -32011
        assert exc.data["reason"] == "grounding_audit_not_pass"


def test_node_promote_fails_when_candidate_formalism_not_in_registry(tmp_path: Path) -> None:
    service = make_service(tmp_path)
    campaign_id, node_id = init_campaign(service)
    _enable_grounding_pass(service, campaign_id, node_id)

    nodes = service.store.load_nodes(campaign_id)
    nodes[node_id]["idea_card"]["candidate_formalisms"] = ["hep/not-in-registry"]
    service.store.save_nodes(campaign_id, nodes)

    try:
        service.handle(
            "node.promote",
            {
                "campaign_id": campaign_id,
                "node_id": node_id,
                "idempotency_key": "promote-formalism-not-in-registry",
            },
        )
        assert False, "expected RpcError"
    except RpcError as exc:
        assert exc.code == -32012
        assert exc.message == "formalism_not_in_registry"
        assert exc.data["reason"] == "schema_invalid"
        assert exc.data["details"]["missing_formalisms"] == ["hep/not-in-registry"]


def test_node_promote_fails_when_idea_card_missing(tmp_path: Path) -> None:
    service = make_service(tmp_path)
    campaign_id, node_id = init_campaign(service)
    _enable_grounding_pass(service, campaign_id, node_id)
    _mutate_node(service, campaign_id, node_id, {"idea_card": None})

    try:
        service.handle(
            "node.promote",
            {
                "campaign_id": campaign_id,
                "node_id": node_id,
                "idempotency_key": "promote-missing-idea-card",
            },
        )
        assert False, "expected RpcError"
    except RpcError as exc:
        assert exc.code == -32002
        assert exc.message == "schema_validation_failed"
        assert exc.data["reason"] == "schema_invalid"
        assert "idea_card is required for promotion" in exc.data["details"]["message"]


def test_node_promote_fails_when_formalization_trace_missing(tmp_path: Path) -> None:
    service = make_service(tmp_path)
    campaign_id, node_id = init_campaign(service)
    _enable_grounding_pass(service, campaign_id, node_id)

    nodes = service.store.load_nodes(campaign_id)
    nodes[node_id]["operator_trace"]["params"] = {}
    service.store.save_nodes(campaign_id, nodes)

    try:
        service.handle(
            "node.promote",
            {
                "campaign_id": campaign_id,
                "node_id": node_id,
                "idempotency_key": "promote-missing-formalization-trace",
            },
        )
        assert False, "expected RpcError"
    except RpcError as exc:
        assert exc.code == -32002
        assert exc.message == "schema_validation_failed"
        assert exc.data["reason"] == "schema_invalid"
        assert "formalization trace missing" in exc.data["details"]["message"]


def test_node_promote_fails_when_formalization_hash_mismatch(tmp_path: Path) -> None:
    service = make_service(tmp_path)
    campaign_id, node_id = init_campaign(service)
    _enable_grounding_pass(service, campaign_id, node_id)

    nodes = service.store.load_nodes(campaign_id)
    nodes[node_id]["operator_trace"]["params"]["formalization"]["rationale_hash"] = (
        "sha256:" + ("0" * 64)
    )
    service.store.save_nodes(campaign_id, nodes)

    try:
        service.handle(
            "node.promote",
            {
                "campaign_id": campaign_id,
                "node_id": node_id,
                "idempotency_key": "promote-formalization-hash-mismatch",
            },
        )
        assert False, "expected RpcError"
    except RpcError as exc:
        assert exc.code == -32002
        assert exc.message == "schema_validation_failed"
        assert exc.data["reason"] == "schema_invalid"
        assert "rationale_hash mismatch" in exc.data["details"]["message"]


def test_node_promote_fails_reduction_audit_missing(tmp_path: Path) -> None:
    service = make_service(tmp_path)
    campaign_id, node_id = init_campaign(service)
    _enable_grounding_pass(service, campaign_id, node_id)

    _mutate_node(service, campaign_id, node_id, {"reduction_report": {"placeholder": True}})

    try:
        service.handle(
            "node.promote",
            {
                "campaign_id": campaign_id,
                "node_id": node_id,
                "idempotency_key": "promote-reduction-missing",
            },
        )
        assert False, "expected RpcError"
    except RpcError as exc:
        assert exc.code == -32016
        assert exc.data["reason"] == "reduction_audit_missing"


def test_node_promote_fails_reduction_audit_not_pass(tmp_path: Path) -> None:
    service = make_service(tmp_path)
    campaign_id, node_id = init_campaign(service)
    _enable_grounding_pass(service, campaign_id, node_id)

    _mutate_node(
        service,
        campaign_id,
        node_id,
        {
            "reduction_report": {"placeholder": True},
            "reduction_audit": {"status": "partial"},
        },
    )

    try:
        service.handle(
            "node.promote",
            {
                "campaign_id": campaign_id,
                "node_id": node_id,
                "idempotency_key": "promote-reduction-not-pass",
            },
        )
        assert False, "expected RpcError"
    except RpcError as exc:
        assert exc.code == -32016
        assert exc.data["reason"] == "reduction_audit_not_pass"


def test_node_promote_fails_abstract_problem_not_in_registry(tmp_path: Path) -> None:
    service = make_service(tmp_path)
    campaign_id, node_id = init_campaign(service)
    _enable_grounding_pass(service, campaign_id, node_id)

    _mutate_node(
        service,
        campaign_id,
        node_id,
        {
            "reduction_report": {"placeholder": True},
            "reduction_audit": {
                "status": "pass",
                "abstract_problem": "unknown_problem",
                "toy_check_result": "pass",
                "assumptions": [{"assumption_id": "a1", "status": "satisfied"}],
            },
        },
    )

    try:
        service.handle(
            "node.promote",
            {
                "campaign_id": campaign_id,
                "node_id": node_id,
                "idempotency_key": "promote-abstract-problem-miss",
            },
        )
        assert False, "expected RpcError"
    except RpcError as exc:
        assert exc.code == -32016
        assert exc.data["reason"] == "abstract_problem_not_in_registry"


def test_node_promote_success_with_reduction(tmp_path: Path) -> None:
    service = make_service(tmp_path)
    campaign_id, node_id = init_campaign(service)
    _enable_grounding_pass(service, campaign_id, node_id)

    _mutate_node(
        service,
        campaign_id,
        node_id,
        {
            "reduction_report": _valid_reduction_report(),
            "reduction_audit": {
                "status": "pass",
                "abstract_problem": "optimization",
                "toy_check_result": "pass",
                "assumptions": [{"assumption_id": "a1", "status": "satisfied"}],
                "reduction_type_valid": True,
                "failures": [],
                "timestamp": "2026-02-13T00:00:00Z",
            },
        },
    )

    result = service.handle(
        "node.promote",
        {
            "campaign_id": campaign_id,
            "node_id": node_id,
            "idempotency_key": "promote-success-with-reduction",
        },
    )

    assert result["has_reduction_report"] is True
    assert result["reduction_audit_summary"]["status"] == "pass"
    assert result["reduction_audit_summary"]["abstract_problem"] == "optimization"


def test_node_promote_idempotency_replay_does_not_duplicate_side_effects(tmp_path: Path) -> None:
    service = make_service(tmp_path)
    campaign_id, node_id = init_campaign(service)
    _enable_grounding_pass(service, campaign_id, node_id)

    before = service.handle("campaign.status", {"campaign_id": campaign_id})
    params = {
        "campaign_id": campaign_id,
        "node_id": node_id,
        "idempotency_key": "promote-replay-once",
    }
    first = service.handle("node.promote", params)
    second = service.handle("node.promote", params)

    assert first["handoff_artifact_ref"] == second["handoff_artifact_ref"]
    assert first["idempotency"]["is_replay"] is False
    assert second["idempotency"]["is_replay"] is True

    after = service.handle("campaign.status", {"campaign_id": campaign_id})
    assert after["budget_snapshot"]["steps_used"] == before["budget_snapshot"]["steps_used"] + 1

    promoted_node = service.handle("node.get", {"campaign_id": campaign_id, "node_id": node_id})
    assert promoted_node["revision"] == 3

    promote_entries = [
        entry
        for entry in _node_log_entries(service, campaign_id)
        if entry.get("mutation") == "promote" and entry.get("node_id") == node_id
    ]
    assert len(promote_entries) == 1


def test_node_promote_idempotency_conflict_includes_payload_hash(tmp_path: Path) -> None:
    service = make_service(tmp_path)
    campaign_id, seed_node_id = init_campaign(service)
    _enable_grounding_pass(service, campaign_id, seed_node_id)

    search_result = service.handle(
        "search.step",
        {
            "campaign_id": campaign_id,
            "n_steps": 1,
            "idempotency_key": "search-for-promote-conflict",
        },
    )
    other_node_id = search_result["new_node_ids"][0]

    service.handle(
        "node.promote",
        {
            "campaign_id": campaign_id,
            "node_id": seed_node_id,
            "idempotency_key": "promote-conflict-key",
        },
    )

    try:
        service.handle(
            "node.promote",
            {
                "campaign_id": campaign_id,
                "node_id": other_node_id,
                "idempotency_key": "promote-conflict-key",
            },
        )
        assert False, "expected RpcError"
    except RpcError as exc:
        assert exc.code == -32002
        assert exc.message == "schema_validation_failed"
        assert exc.data["reason"] == "idempotency_key_conflict"
        assert exc.data["idempotency_key"] == "promote-conflict-key"
        assert exc.data["payload_hash"].startswith("sha256:")
