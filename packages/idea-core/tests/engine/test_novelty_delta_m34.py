from __future__ import annotations

from pathlib import Path

from idea_core.contracts.validate import DEFAULT_CONTRACT_DIR
from idea_core.engine.coordinator import IdeaCoreService


def make_service(tmp_path: Path) -> IdeaCoreService:
    return IdeaCoreService(data_dir=tmp_path / "runs", contract_dir=DEFAULT_CONTRACT_DIR)


def init_campaign(service: IdeaCoreService, *, duplicate_seeds: bool = False) -> str:
    if duplicate_seeds:
        seeds = [
            {
                "seed_type": "text",
                "content": "constraint-driven EFT toy estimate for rare decay",
                "source_uris": ["https://example.org/prior-a"],
            },
            {
                "seed_type": "text",
                "content": "constraint-driven EFT toy estimate for rare decay",
                "source_uris": ["https://example.org/prior-a"],
            },
        ]
    else:
        seeds = [
            {
                "seed_type": "text",
                "content": "bridge deformation around semileptonic anomaly",
                "source_uris": ["https://example.org/seed-1"],
            },
            {
                "seed_type": "text",
                "content": "limit-driven consistency check in EFT",
                "source_uris": ["https://example.org/seed-2"],
            },
        ]

    result = service.handle(
        "campaign.init",
        {
            "charter": {
                "campaign_name": "m3.4-novelty-fixture",
                "domain": "hep-ph",
                "scope": "m3.4 novelty delta fixture",
                "approval_gate_ref": "gate://a0.1",
            },
            "seed_pack": {"seeds": seeds},
            "budget": {
                "max_tokens": 100000,
                "max_cost_usd": 100.0,
                "max_wall_clock_s": 100000,
                "max_steps": 50,
            },
            "idempotency_key": "m3.4-init",
        },
    )
    return result["campaign_id"]


def test_eval_run_emits_novelty_delta_table_with_explicit_flags(tmp_path: Path) -> None:
    service = make_service(tmp_path)
    campaign_id = init_campaign(service)
    node_ids = sorted(service.store.load_nodes(campaign_id).keys())

    eval_result = service.handle(
        "eval.run",
        {
            "campaign_id": campaign_id,
            "node_ids": node_ids,
            "evaluator_config": {"dimensions": ["novelty", "impact"], "n_reviewers": 2},
            "idempotency_key": "m3.4-eval-novelty",
        },
    )
    scorecards_payload = service.store.load_artifact_from_ref(eval_result["scorecards_artifact_ref"])

    assert len(scorecards_payload["scorecards"]) == len(node_ids)
    for scorecard in scorecards_payload["scorecards"]:
        novelty_delta_table = scorecard.get("novelty_delta_table")
        assert isinstance(novelty_delta_table, list) and novelty_delta_table
        for entry in novelty_delta_table:
            assert isinstance(entry["closest_prior_uris"], list) and entry["closest_prior_uris"]
            assert isinstance(entry["delta_types"], list) and entry["delta_types"]
            assert isinstance(entry["delta_statement"], str) and entry["delta_statement"]
            assert isinstance(entry["verification_hook"], str) and entry["verification_hook"]
            assert "non_novelty_flags" in entry
            assert isinstance(entry["non_novelty_flags"], list)

    first_node = service.handle(
        "node.get",
        {"campaign_id": campaign_id, "node_id": node_ids[0]},
    )
    assert first_node["eval_info"]["novelty_delta_table"] == scorecards_payload["scorecards"][0]["novelty_delta_table"]


def test_eval_run_flags_non_novel_duplicate_seed_claims(tmp_path: Path) -> None:
    service = make_service(tmp_path)
    campaign_id = init_campaign(service, duplicate_seeds=True)
    node_ids = sorted(service.store.load_nodes(campaign_id).keys())

    eval_result = service.handle(
        "eval.run",
        {
            "campaign_id": campaign_id,
            "node_ids": node_ids,
            "evaluator_config": {"dimensions": ["novelty"], "n_reviewers": 2},
            "idempotency_key": "m3.4-eval-duplicates",
        },
    )
    scorecards_payload = service.store.load_artifact_from_ref(eval_result["scorecards_artifact_ref"])

    observed_flags: set[str] = set()
    for scorecard in scorecards_payload["scorecards"]:
        for entry in scorecard["novelty_delta_table"]:
            observed_flags.update(entry.get("non_novelty_flags", []))

    assert observed_flags
    assert observed_flags & {
        "parameter_tuning_only",
        "relabeling_only",
        "equivalent_reformulation",
        "no_new_prediction",
        "known_components_no_testable_delta",
    }


def test_eval_run_without_novelty_dimension_omits_delta_table(tmp_path: Path) -> None:
    service = make_service(tmp_path)
    campaign_id = init_campaign(service)
    node_ids = sorted(service.store.load_nodes(campaign_id).keys())

    eval_result = service.handle(
        "eval.run",
        {
            "campaign_id": campaign_id,
            "node_ids": node_ids,
            "evaluator_config": {"dimensions": ["impact"], "n_reviewers": 2},
            "idempotency_key": "m3.4-eval-impact-only",
        },
    )
    scorecards_payload = service.store.load_artifact_from_ref(eval_result["scorecards_artifact_ref"])

    for scorecard in scorecards_payload["scorecards"]:
        assert "novelty_delta_table" not in scorecard
    for node_id in node_ids:
        node = service.handle(
            "node.get",
            {"campaign_id": campaign_id, "node_id": node_id},
        )
        assert "novelty_delta_table" not in node["eval_info"]


def test_infer_non_novelty_flags_thresholds_are_stable(tmp_path: Path) -> None:
    service = make_service(tmp_path)
    prior_node = {
        "idea_card": {
            "claims": [
                {
                    "claim_text": "Model predicts a measurable observable shift under the same setup.",
                    "evidence_uris": ["https://example.org/prior-a"],
                }
            ]
        },
        "operator_trace": {"evidence_uris_used": ["https://example.org/prior-a"]},
    }
    node = {
        "idea_card": {
            "claims": [
                {
                    "claim_text": "Model predicts a measurable observable shift under the same setup.",
                    "evidence_uris": ["https://example.org/prior-a"],
                }
            ]
        },
        "operator_trace": {"evidence_uris_used": ["https://example.org/prior-a"]},
    }

    high_similarity_flags = service._infer_non_novelty_flags(
        node=node,
        prior_node=prior_node,
        claim_similarity=0.95,
    )
    assert "equivalent_reformulation" in high_similarity_flags

    medium_similarity_flags = service._infer_non_novelty_flags(
        node=node,
        prior_node=prior_node,
        claim_similarity=0.8,
    )
    assert "parameter_tuning_only" in medium_similarity_flags
    assert "equivalent_reformulation" not in medium_similarity_flags


def test_build_novelty_delta_table_uses_internal_prior_placeholder_when_missing(tmp_path: Path) -> None:
    service = make_service(tmp_path)
    node_id = "node-1"
    node = {
        "operator_id": "dummy.operator",
        "operator_family": "DummyFamily",
        "rationale_draft": {"rationale": "non-predictive placeholder"},
        "idea_card": None,
        "operator_trace": {},
    }

    novelty_delta_table = service._build_novelty_delta_table(
        node_id=node_id,
        node=node,
        nodes={node_id: node},
    )

    assert len(novelty_delta_table) == 1
    uris = novelty_delta_table[0]["closest_prior_uris"]
    assert uris
    assert uris[0] == "urn:idea-core:novelty-prior-unavailable:node-1"


def test_novelty_delta_table_uses_provider_neutral_language(tmp_path: Path) -> None:
    service = make_service(tmp_path)
    node = {
        "operator_id": "math.bridge.operator",
        "operator_family": "FrameworkBridge",
        "rationale_draft": {"rationale": "framework bridge"},
        "idea_card": {
            "claims": [
                {
                    "claim_text": "A framework reformulation introduces a measurable output shift.",
                    "evidence_uris": ["https://example.org/prior-math"],
                }
            ],
            "minimal_compute_plan": [{"method": "symbolic comparison"}],
        },
        "operator_trace": {"evidence_uris_used": ["https://example.org/prior-math"]},
    }

    novelty_delta_table = service._build_novelty_delta_table(
        node_id="node-1",
        node=node,
        nodes={"node-1": node},
    )

    entry = novelty_delta_table[0]
    assert "observable-1" not in entry["delta_statement"]
    assert "observable-1" not in entry["verification_hook"]
    assert "closest prior baseline" in entry["delta_statement"]
    assert "closest prior evidence baseline" in entry["verification_hook"]
