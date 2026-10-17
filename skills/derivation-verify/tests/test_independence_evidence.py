"""Offline acceptance witnesses; no scientific result or live reviewer is claimed."""
import importlib.util
import hashlib
import json
from pathlib import Path

import pytest
from assessment_fixture import transport_for

SCRIPT = Path(__file__).resolve().parents[1] / "scripts/run_multi_backend.py"
spec = importlib.util.spec_from_file_location("independence_executor", SCRIPT)
mb = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mb)


def bound_comparison(ds, **fields):
    return {**fields, "assessment_input_sha256": hashlib.sha256(json.dumps(ds, ensure_ascii=False, sort_keys=True).encode()).hexdigest()}


def lane(i, method="direct construction"):
    d = {"canonical_answer": "42", "checkable_form": "42", "execution_id": f"fresh-{i}",
            "method": method, "derivation_summary": f"Lane {i} constructed its expression from neutral raw inputs; evaluated 17 plus 25; checked exact arithmetic preconditions and diagnostic bounds."}

    d["derivation"] = d["derivation_summary"]
    d["transport"] = transport_for("42", d["derivation"], d["execution_id"])
    observed = mb._execute_derivation(lambda *args: json.dumps(d), "claude/offline-fixture", "Offline host execution",
                                      "Neutral raw inputs 17 and 25; derive independently.", d["execution_id"])
    observed["method"] = method
    return observed


def assessment(i, d):
    return {"index": i, "input_independent": True, "execution_independent": True,
            "construction_independent": True, "method_applicable": True, "diagnostic": True,
            "unresolved_defects": [], "evidence": {
                k: {"source_span": d["derivation_summary"], "reason": f"The observed lane steps support {k}; inspected the raw inputs, construction and exact arithmetic limits."}
                for k in ("input", "execution", "construction", "applicability", "diagnostic")}}


def test_construction_quote_cannot_be_supplied_by_shared_source():
    from independence import assessed_indices
    d = lane(0)
    d["construction_body"] = "Own source accumulates each neutral operand exactly once."
    shared = "Shared dependency implements the full claimant computation."
    d["derivation"] += "\n" + d["construction_body"] + "\n" + shared
    record = assessment(0, d)
    record["evidence"]["construction"]["source_span"] = shared
    assert assessed_indices([d], [record]) == []
    record["evidence"]["construction"]["source_span"] = d["construction_body"]
    assert assessed_indices([d], [record]) == [0]



def test_construction_body_quote_compares_line_endings_as_equal():
    from independence import assessed_indices
    for ending in ("\r\n", "\r"):
        d = lane(0)
        d["construction_body"] = ending.join(("total = 0", "for value in values: total += value", ""))
        record = assessment(0, d)
        record["evidence"]["construction"]["source_span"] = "total = 0\nfor value in values: total += value"
        assert assessed_indices([d], [record]) == [0], repr(ending)
        record["evidence"]["construction"]["source_span"] = "total = 0\nfor value in values: total -= value"
        assert assessed_indices([d], [record]) == [], repr(ending)
        record["evidence"]["construction"]["source_span"] = "\n"
        assert assessed_indices([d], [record]) == [], repr(ending)
        # Other whitespace is content (indentation can carry structure) and must match exactly.
        for changed in ("total = 0\nfor value in values:  total += value", "total = 0\n  for value in values: total += value"):
            record["evidence"]["construction"]["source_span"] = changed
            assert assessed_indices([d], [record]) == [], (repr(ending), changed)


@pytest.mark.parametrize("case,expected", [
    ("same_method_independent", True), ("similar_method_independent", True),
    ("different_method_polluted", False), ("original_code_rerun", False),
    ("shared_library_independent_construction", True), ("method_defect", False),
])
def test_acceptance_cases(case, expected):
    ds = [lane(0), lane(1)]
    if case == "similar_method_independent":
        ds[1]["method"] = "direct construction with regrouping"
    if case == "shared_library_independent_construction":
        for d in ds:
            d["library_sha256"] = "a" * 64
    aa = [assessment(i, d) for i, d in enumerate(ds)]
    if case == "different_method_polluted":
        ds[1]["method"] = "different algorithm"
        aa[1]["input_independent"] = False
    if case == "original_code_rerun":
        aa[1]["construction_independent"] = False
    if case == "method_defect":
        aa[1]["unresolved_defects"] = ["The applicability precondition is violated in this input regime."]
    cmp = bound_comparison(ds, majority_answer=ds[0]["canonical_answer"], majority_indices=[0, 1], majority_size=2,
                           adjudicated_matches_majority=True, independence_assessments=aa)
    accepted, _, _ = mb.claim_status(cmp, ds, ["same-family", "same-family"])
    assert accepted is expected


def test_checkbox_or_missing_assessment_never_passes():
    ds = [lane(0), lane(1)]
    for aa in ([], [{"index": 0, "no_known_defects": True}, {"index": 1, "no_known_defects": True}]):
        assert mb.claim_status(bound_comparison(ds, majority_indices=[0, 1], independence_assessments=aa), ds, ["a", "b"])[0] is False


def test_reused_execution_does_not_count_twice():
    ds = [lane(0), lane(1)]
    ds[1]["execution_id"] = ds[0]["execution_id"]
    cmp = bound_comparison(ds, independence_assessments=[assessment(i, d) for i, d in enumerate(ds)])
    assert mb.claim_status(cmp, ds, ["a", "b"])[0] is False


@pytest.mark.parametrize("value", ["true", "false", "0", 1, 0, None, [], {}])
def test_non_boolean_flags_never_approve(value):
    parsed = mb.parse_comparison(json.dumps({"majority_size": 2, "majority_indices": [0, 1],
        "adjudicated_matches_majority": value}), 2)
    assert parsed["adjudicated_matches_majority"] is False
    ds = [lane(0), lane(1)]
    aa = [assessment(i, d) for i, d in enumerate(ds)]
    aa[1]["method_applicable"] = value
    assert mb.claim_status(bound_comparison(ds, independence_assessments=aa), ds, ["a", "b"])[0] is False


def test_boolean_indices_do_not_alias_lane_numbers():
    parsed = mb.parse_comparison('{"majority_size":2,"majority_indices":[false,true]}', 2)
    assert parsed is None


def _panel_verdict(ds, judge, eligible=None):
    aa = [assessment(i, d) for i, d in enumerate(ds)]
    for a in aa:
        for item in a["evidence"].values():
            item["reason"] += f" Independent examiner {judge} gives its own source analysis."
        if eligible is not None and a["index"] not in eligible:
            a["input_independent"] = False
    return {**bound_comparison(ds), "majority_answer": "42", "majority_size": len(ds), "majority_indices": list(range(len(ds))),
        "adjudicated_matches_majority": True, "correct_answer_adjudicated": "42", "outliers": "none",
        "independence_assessments": aa, "method_risk_assessments": []}


def test_panel_accepts_valid_complete_judgments_with_different_explanations():
    ds = [lane(0), lane(1)]
    verdicts = [_panel_verdict(ds, j) for j in range(3)]
    verdicts[2]["independence_assessments"][1]["input_independent"] = False
    cmp, count = mb._aggregate_judges(verdicts, 2, ds)
    assert count == 3
    # Production _compare binds the observed complete request after aggregation.
    cmp = bound_comparison(ds, **cmp)
    assert mb.claim_status(cmp, ds, ["same-family"] * 2)[0] is True


def test_comparison_without_actual_input_binding_cannot_confirm():
    ds = [lane(0), lane(1)]
    cmp = _panel_verdict(ds, 0)
    assert mb.claim_status(cmp, ds, ["same-family"] * 2)[0] is True
    cmp.pop("assessment_input_sha256")
    assert mb.claim_status(cmp, ds, ["same-family"] * 2)[0] is False


def test_final_adjudication_cannot_be_taken_from_a_minority_veto():
    ds=[lane(0),lane(1)]
    verdicts=[_panel_verdict(ds,j) for j in range(3)]
    verdicts[0]['adjudicated_matches_majority']=False
    verdicts[0]['correct_answer_adjudicated']='41 (minority veto)'
    cmp,count=mb._aggregate_judges(verdicts,2,ds)
    assert count==3 and cmp['correct_answer_adjudicated']=='42'
    cmp=bound_comparison(ds,**cmp)
    assert mb.claim_status(cmp,ds,['same-family']*2)[0] is True


def test_panel_never_synthesizes_axes_or_lane_sets_from_partial_approvals():
    ds = [lane(i) for i in range(3)]
    verdicts = [_panel_verdict(ds, j, eligible) for j, eligible in enumerate(({0, 1}, {0, 2}, {1, 2}))]
    cmp, _ = mb._aggregate_judges(verdicts, 3, ds)
    assert cmp["independence_assessments"] == []
    assert mb.claim_status(cmp, ds, ["same-family"] * 3)[0] is False
    ds = ds[:2]
    verdicts = [_panel_verdict(ds, j) for j in range(3)]
    for verdict, axis in zip(verdicts, ("input", "execution", "construction")):
        verdict["independence_assessments"][1][axis + "_independent"] = False
    cmp, _ = mb._aggregate_judges(verdicts, 2, ds)
    assert mb.claim_status(cmp, ds, ["same-family"] * 2)[0] is False


def test_panel_votes_on_complete_source_validated_method_risk_records():
    ds = [lane(0), lane(1)]
    verdicts = [_panel_verdict(ds, j) for j in range(2)]
    for j, v in enumerate(verdicts):
        v["method_risk_assessments"] = [{"indices": [0, 1], "addresses_shared_failure": True,
            "methods_distinct": True, "risk": "Shared transcription failure must be exposed by original source inspection.",
            "method_analysis": f"Examiner {j} independently inspects both raw-operand constructions for the declared failure.",
            "evidence": [{"index": i, "source_span": d["derivation"],
                "reason": f"Examiner {j} binds the observed construction to its own applicable shared-failure analysis."}
                for i, d in enumerate(ds)]}]
    cmp, _ = mb._aggregate_judges(verdicts, 2, ds)
    assert mb.method_risk_passes(ds, [0, 1], cmp["method_risk_assessments"]) is True
    verdicts[1]["method_risk_assessments"][0]["evidence"][1]["source_span"] = "unobserved author claim"
    cmp, _ = mb._aggregate_judges(verdicts, 2, ds)
    assert mb.method_risk_passes(ds, [0, 1], cmp["method_risk_assessments"]) is False


def test_shared_convergence_helper_rejects_unbound_published_answer():
    ds = [lane(0), lane(1)]
    cmp = _panel_verdict(ds, 0)
    cmp["majority_answer"] = "43"
    assert mb.decide_converged(cmp, ["same-family"] * 2, derivations=ds) is False


def test_single_backend_runs_two_fresh_blind_lanes_and_consumes_assessment():
    seen = []
    def run(model, system, prompt, tag):
        seen.append((tag, prompt))
        if "compare" in tag:
            ds = [lane(0), lane(1)]
            return json.dumps({"majority_answer": "42", "majority_size": 2, "majority_indices": [0, 1],
                "adjudicated_matches_majority": True, "independence_assessments": [assessment(i, d) for i, d in enumerate(ds)]})
        i = 0 if "derive0" in tag else 1
        return json.dumps(lane(i))
    c = {"id": "neutral", "statement": "Compute the sum of 17 and 25.", "report_format": "integer", "method0": "add", "method1": "add"}
    row = mb.verify_claim(c, ctx="neutral inputs", pool=["claude/opus"], comparators=["claude/opus"], max_iter=0, run=run)
    assert row["converged"] and row["independent_confirmations"] == 2
    assert row["cross_family_confirmations"] == 1
    assert len({tag for tag, _ in seen if "derive" in tag}) == 2
    assert '"42"' not in mb._tiebreak_prompt("neutral", c, "add", [{"canonical_answer": "42"}])


@pytest.mark.parametrize("key,value", [
    ("requires_method_diversity", v) for v in ("true", 1, None, [], {})
] + [("method_diversity_risk", v) for v in (True, 1, None, [], {})])
def test_invalid_claim_controls_reject_before_direct_or_gate_dispatch(key, value):
    calls = []
    def run(*args):
        calls.append(args)
        raise AssertionError("Invalid claim must not dispatch")
    claim = {"id": "invalid-control", "statement": "Derive from raw inputs", key: value}
    direct = mb.verify_claim(claim, ctx="", pool=["claude/offline"], comparators=["claude/offline"], max_iter=0, run=run)
    gate = mb.run_gate({"claims": [claim], "max_iter": 0}, pool=["claude/offline"], comparators=["claude/offline"], run=run)
    for row in (direct, gate["matrix"][0]):
        assert row["converged"] is False
        assert row["independent_confirmations"] == 0
        assert row["agreed_answer"] is None and row["adjudicated_correct"] is None
        assert row["status"] == "unavailable"
    assert calls == []


def test_literal_false_claim_control_keeps_dispatch():
    calls = []
    def run(*args):
        calls.append(args)
        return None
    row = mb.verify_claim({"id": "valid-control", "statement": "Derive from raw inputs", "report_format": "integer", "requires_method_diversity": False,
                           "method_diversity_risk": ""}, ctx="", pool=["claude/offline"], comparators=["claude/offline"], max_iter=0, run=run)
    assert calls
    assert row["independent_confirmations"] == 0
