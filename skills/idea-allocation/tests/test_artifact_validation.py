"""Hand-rolled allocation_decision_v1 validator: accepts good, rejects broken."""

from __future__ import annotations

import copy
import json
from pathlib import Path

import pytest

import nodes_store
import thompson_allocation as ta


def good_artifact():
    # All handle ids are engine short ids: 8 chars of lowercase Crockford
    # base32 (allocation_decision_v1 / idea_node_v1 convention).
    return {
        "decision_id": "8c50c1f0",
        "campaign_id": "0f3c2c8e",
        "generated_at": "2026-07-05T00:00:00Z",
        "method": "thompson_sampling",
        "random_seed": 42,
        "candidates": [
            {
                "node_id": "a1pha000",
                "posterior_value": 0.85,
                "evidence_count": 40,
                "sampled_value": 0.8712,
                "posterior_status": "current",
                "literature_coverage_status": "saturated",
                "allocation_eligible": True,
                "exploratory_allocation": False,
                "allocation": "deep_investment",
                "budget_note": "deep slot 1 of 1; sampled above posterior mean — exploration draw",
            },
            {
                "node_id": "gamma000",
                "posterior_value": None,
                "evidence_count": None,
                "sampled_value": None,
                "posterior_status": None,
                "literature_coverage_status": "metadata_only",
                "allocation_eligible": False,
                "exploratory_allocation": False,
                "allocation": "reconnaissance",
                "budget_note": "no posterior yet — needs belief graph first",
            },
        ],
        "waiting_activation": [
            {
                "node_id": "de1ta000",
                "activation_condition": {
                    "kind": "tool_readiness",
                    "description": "solver toolchain passes its seeded smoke run",
                    "satisfied": False,
                },
                "last_checked_at": "2026-06-28T16:00:00Z",
            },
            {
                "node_id": "10ta0000",
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


def test_bad_id_fields():
    probs = problems_after(lambda a: a.__setitem__("decision_id", "not-a-short-id"))
    assert any("decision_id" in p and "engine short id" in p for p in probs)
    probs = problems_after(lambda a: a.__setitem__("campaign_id", 42))
    assert any("campaign_id" in p for p in probs)


@pytest.mark.parametrize("field", ["decision_id", "campaign_id"])
@pytest.mark.parametrize(
    "bad_value",
    [
        # The retired dashed-uuid convention is exactly what the engine
        # contract excludes; it must be rejected, not tolerated.
        "8c50c1f0-a41c-5d3e-9d1b-6f2a3b4c5d6e",
        "abcdilou",   # 8 lowercase chars, but i/l/o/u sit outside Crockford
        "8c50c1f",    # right alphabet, wrong length
        "8C50C1F0",   # uppercase is excluded
    ],
)
def test_top_level_ids_reject_non_engine_forms(field, bad_value):
    probs = problems_after(lambda a: a.__setitem__(field, bad_value))
    assert any(field in p and "engine short id" in p for p in probs)


def test_node_ids_reject_non_engine_forms():
    dashed = "4c9a2d10-7e5f-4b8a-9c3d-6e1f2a3b4c5d"

    def bad_candidate(artifact):
        artifact["candidates"][0]["node_id"] = dashed

    assert any(
        "node_id" in p and "engine short id" in p for p in problems_after(bad_candidate)
    )

    def bad_waiting(artifact):
        artifact["waiting_activation"][0]["node_id"] = dashed

    assert any(
        "node_id" in p and "engine short id" in p for p in problems_after(bad_waiting)
    )


# ---------------------------------------------------------------------------
# Anti-drift lock against the engine contract
# ---------------------------------------------------------------------------

ENGINE_ALLOCATION_SCHEMA = (
    Path(__file__).resolve().parents[3]
    / "packages"
    / "idea-engine"
    / "contracts"
    / "idea-runtime-contracts"
    / "schemas"
    / "allocation_decision_v1.schema.json"
)


def test_short_id_pattern_matches_engine_contract():
    """Anti-drift lock on the campaign-store seam: the skill validator's id
    regex must be byte-for-byte the engine allocation_decision_v1 pattern for
    decision_id, campaign_id, and both node_id fields. The pattern is read
    from the engine schema file at test time, never copied here as a literal.
    Skipped only when the skill runs standalone, away from the engine
    contract tree."""
    if not ENGINE_ALLOCATION_SCHEMA.is_file():
        pytest.skip("engine contract tree not present (standalone install)")
    schema = json.loads(ENGINE_ALLOCATION_SCHEMA.read_text(encoding="utf-8"))
    props = schema["properties"]
    engine_patterns = {
        "decision_id": props["decision_id"]["pattern"],
        "campaign_id": props["campaign_id"]["pattern"],
        "candidates[].node_id": (
            props["candidates"]["items"]["properties"]["node_id"]["pattern"]
        ),
        "waiting_activation[].node_id": (
            props["waiting_activation"]["items"]["properties"]["node_id"]["pattern"]
        ),
    }
    for field, engine_pattern in engine_patterns.items():
        assert engine_pattern == nodes_store.SHORT_ID_RE.pattern, field


def test_is_short_id_text_is_exactly_as_strict_as_the_engine_regex():
    """The string-level pattern lock above cannot see cross-engine matching
    semantics: Python's re.match + ``$`` accepts one trailing newline that the
    engine-side JS regex rejects. is_short_id_text must use fullmatch."""
    assert nodes_store.is_short_id_text("abcd1234")
    assert not nodes_store.is_short_id_text("abcd1234\n")
    assert not nodes_store.is_short_id_text("ABCD1234")
    assert not nodes_store.is_short_id_text("abcd123")
    assert not nodes_store.is_short_id_text("abcdilou")


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

    def bad_coverage_status(artifact):
        artifact["candidates"][0]["literature_coverage_status"] = "skimmed"

    assert any("literature_coverage_status" in p for p in problems_after(bad_coverage_status))

    def bad_posterior_status(artifact):
        artifact["candidates"][0]["posterior_status"] = "old"

    assert any("posterior_status" in p for p in problems_after(bad_posterior_status))

    def bad_eligible_type(artifact):
        artifact["candidates"][0]["allocation_eligible"] = "yes"

    assert any("allocation_eligible" in p for p in problems_after(bad_eligible_type))

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


def test_literature_coverage_eligibility_rules():
    def incomplete_without_exploratory(artifact):
        artifact["candidates"][0]["literature_coverage_status"] = "coverage_incomplete"
        artifact["candidates"][0]["allocation_eligible"] = True
        artifact["candidates"][0]["exploratory_allocation"] = False

    assert any("coverage_incomplete" in p and "exploratory_allocation" in p for p in problems_after(incomplete_without_exploratory))

    def metadata_only_eligible(artifact):
        artifact["candidates"][0]["literature_coverage_status"] = "metadata_only"
        artifact["candidates"][0]["allocation_eligible"] = True

    assert any("metadata_only" in p and "allocation_eligible" in p for p in problems_after(metadata_only_eligible))

    artifact = good_artifact()
    artifact["candidates"][0]["literature_coverage_status"] = "coverage_incomplete"
    artifact["candidates"][0]["allocation_eligible"] = True
    artifact["candidates"][0]["exploratory_allocation"] = True
    assert ta.validate_allocation_decision(artifact) == []

    def stale_eligible(artifact):
        artifact["candidates"][0]["posterior_status"] = "stale"

    assert any("posterior_status=current" in p for p in problems_after(stale_eligible))


def test_posterior_candidate_without_sample_is_a_coverage_hold():
    artifact = good_artifact()
    artifact["candidates"][0]["sampled_value"] = None
    artifact["candidates"][0]["allocation"] = "hold"
    artifact["candidates"][0]["allocation_eligible"] = False
    artifact["candidates"][0]["posterior_status"] = "current"
    artifact["candidates"][0]["literature_coverage_status"] = "coverage_incomplete"
    artifact["candidates"][0]["budget_note"] = "not allocation eligible: literature coverage is coverage_incomplete"
    assert ta.validate_allocation_decision(artifact) == []


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
