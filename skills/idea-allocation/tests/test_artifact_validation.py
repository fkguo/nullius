"""Hand-rolled allocation_decision_v1 validator: accepts good, rejects broken."""

from __future__ import annotations

import copy

import thompson_allocation as ta


def good_artifact():
    return {
        "decision_id": "8c50c1f0-a41c-5d3e-9d1b-6f2a3b4c5d6e",
        "campaign_id": "0f3c2c8e-5df1-4a3a-9b6e-2f1a7c9d4e10",
        "generated_at": "2026-07-05T00:00:00Z",
        "method": "thompson_sampling",
        "random_seed": 42,
        "candidates": [
            {
                "node_id": "idea-alpha",
                "posterior_value": 0.85,
                "evidence_count": 40,
                "sampled_value": 0.8712,
                "allocation": "deep_investment",
                "budget_note": "deep slot 1 of 1; sampled above posterior mean — exploration draw",
            },
            {
                "node_id": "idea-gamma",
                "posterior_value": None,
                "evidence_count": None,
                "sampled_value": None,
                "allocation": "reconnaissance",
                "budget_note": "no posterior yet — needs belief graph first",
            },
        ],
        "waiting_activation": [
            {
                "node_id": "idea-delta",
                "activation_condition": {
                    "kind": "tool_readiness",
                    "description": "solver toolchain passes its seeded smoke run",
                    "satisfied": False,
                },
                "last_checked_at": "2026-06-28T16:00:00Z",
            },
            {
                "node_id": "idea-iota",
                "activation_condition": {
                    "kind": "stage_reached",
                    "description": "campaign reaches the calibration-complete milestone",
                    "satisfied": False,
                },
                "last_checked_at": None,
            },
        ],
    }


def problems_after(mutate):
    artifact = good_artifact()
    mutate(artifact)
    return ta.validate_allocation_decision(artifact)


def test_good_artifact_is_valid():
    assert ta.validate_allocation_decision(good_artifact()) == []


def test_non_object_rejected():
    assert ta.validate_allocation_decision([]) != []
    assert ta.validate_allocation_decision(None) != []


def test_missing_and_extra_top_level_keys():
    probs = problems_after(lambda a: a.pop("decision_id"))
    assert any("missing top-level keys" in p and "decision_id" in p for p in probs)
    probs = problems_after(lambda a: a.__setitem__("surprise", 1))
    assert any("unexpected top-level keys" in p for p in probs)


def test_bad_uuid_fields():
    probs = problems_after(lambda a: a.__setitem__("decision_id", "not-a-uuid"))
    assert any("decision_id" in p for p in probs)
    probs = problems_after(lambda a: a.__setitem__("campaign_id", 42))
    assert any("campaign_id" in p for p in probs)


def test_bad_generated_at_and_method_and_seed():
    probs = problems_after(lambda a: a.__setitem__("generated_at", "yesterday"))
    assert any("generated_at" in p for p in probs)
    probs = problems_after(lambda a: a.__setitem__("method", "greedy"))
    assert any("method" in p for p in probs)
    probs = problems_after(lambda a: a.__setitem__("random_seed", "42"))
    assert any("random_seed" in p for p in probs)
    probs = problems_after(lambda a: a.__setitem__("random_seed", True))
    assert any("random_seed" in p for p in probs)


def test_candidate_shape_enforced():
    def drop_key(artifact):
        del artifact["candidates"][0]["budget_note"]

    assert any("missing keys" in p for p in problems_after(drop_key))

    def extra_key(artifact):
        artifact["candidates"][0]["mood"] = "sunny"

    assert any("unexpected keys" in p for p in problems_after(extra_key))

    def bad_allocation(artifact):
        artifact["candidates"][0]["allocation"] = "yolo"

    assert any("allocation" in p for p in problems_after(bad_allocation))

    def bad_range(artifact):
        artifact["candidates"][0]["posterior_value"] = 1.5

    assert any("posterior_value" in p for p in problems_after(bad_range))

    def bad_count(artifact):
        artifact["candidates"][0]["evidence_count"] = -3

    assert any("evidence_count" in p for p in problems_after(bad_count))

    def candidates_not_list(artifact):
        artifact["candidates"] = {}

    assert any("candidates must be a list" in p for p in problems_after(candidates_not_list))


def test_cold_start_triple_rules():
    # Mixed null triple is invalid.
    def mixed(artifact):
        artifact["candidates"][1]["sampled_value"] = 0.5

    assert any("all" in p and "null" in p for p in problems_after(mixed))

    # A full-null cold start must be reconnaissance, never deep or hold.
    def cold_deep(artifact):
        artifact["candidates"][1]["allocation"] = "deep_investment"

    assert any("cold start" in p for p in problems_after(cold_deep))


def test_waiting_shape_enforced():
    def bad_kind(artifact):
        artifact["waiting_activation"][0]["activation_condition"]["kind"] = "vibes"

    assert any("kind" in p for p in problems_after(bad_kind))

    def bad_satisfied(artifact):
        artifact["waiting_activation"][0]["activation_condition"]["satisfied"] = "no"

    assert any("satisfied" in p for p in problems_after(bad_satisfied))

    def empty_description(artifact):
        artifact["waiting_activation"][0]["activation_condition"]["description"] = "  "

    assert any("description" in p for p in problems_after(empty_description))

    def bad_checked(artifact):
        artifact["waiting_activation"][1]["last_checked_at"] = "recently"

    assert any("last_checked_at" in p for p in problems_after(bad_checked))

    def extra_waiting_key(artifact):
        artifact["waiting_activation"][0]["note"] = "x"

    assert any("unexpected keys" in p for p in problems_after(extra_waiting_key))


def test_validator_reports_multiple_problems_at_once():
    artifact = good_artifact()
    artifact["method"] = "greedy"
    artifact["random_seed"] = "x"
    artifact["candidates"][0]["allocation"] = "yolo"
    probs = ta.validate_allocation_decision(artifact)
    assert len(probs) >= 3


def test_validator_does_not_mutate_input():
    artifact = good_artifact()
    snapshot = copy.deepcopy(artifact)
    ta.validate_allocation_decision(artifact)
    assert artifact == snapshot
