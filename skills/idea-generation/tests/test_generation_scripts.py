"""Tests for the idea-generation mechanical scripts + engine-contract locks."""

from __future__ import annotations

import copy
import json
import os
import re
import subprocess
import sys
from pathlib import Path

import pytest

import build_pack
import dedup_check
import submit_pack

TESTS_DIR = Path(__file__).resolve().parent
SKILL_ROOT = TESTS_DIR.parents[0]


# ---------------------------------------------------------------------------
# dedup_check
# ---------------------------------------------------------------------------

def _store_nodes(texts):
    return {
        f"nd{index:06d}": {
            "idea_card": {"thesis_statement": text, "claims": [], "testable_hypotheses": []},
            "node_id": f"nd{index:06d}",
            "rationale_draft": {"rationale": text, "title": f"node {index}"},
        }
        for index, text in enumerate(texts)
    }


def test_dedup_identical_text_auto_drops_and_unrelated_is_unique(tmp_path, make_candidate):
    candidate = make_candidate()
    duplicate_text = " ".join([
        candidate["rationale_draft"]["title"],
        candidate["rationale_draft"]["rationale"],
        candidate["card_fields"]["testable_hypotheses"][0],
        candidate["card_fields"]["claims"][0]["claim_text"],
        candidate["card_fields"]["claims"][1]["claim_text"],
    ])
    nodes = _store_nodes([duplicate_text, "a completely different topic about unrelated machinery"])
    nodes_path = tmp_path / "nodes_latest.json"
    nodes_path.write_text(json.dumps(nodes), encoding="utf-8")
    candidates_path = tmp_path / "candidates.json"
    candidates_path.write_text(json.dumps([candidate]), encoding="utf-8")
    out_path = tmp_path / "report.json"

    assert dedup_check.run([
        "--nodes", str(nodes_path),
        "--candidates", str(candidates_path),
        "--out", str(out_path),
    ]) == 0
    report = json.loads(out_path.read_text(encoding="utf-8"))
    entry = report["results"][0]
    assert entry["decision"] == "auto_drop"
    assert entry["nearest_neighbor_node_id"] == "nd000000"
    assert entry["nearest_similarity"] >= 0.95

    unrelated = _store_nodes(["an entirely disjoint subject with nothing shared at all"])
    nodes_path2 = tmp_path / "nodes2.json"
    nodes_path2.write_text(json.dumps(unrelated), encoding="utf-8")
    out2 = tmp_path / "report2.json"
    assert dedup_check.run([
        "--nodes", str(nodes_path2),
        "--candidates", str(candidates_path),
        "--out", str(out2),
    ]) == 0
    assert json.loads(out2.read_text(encoding="utf-8"))["results"][0]["decision"] == "unique"


def test_dedup_report_is_byte_deterministic_and_refuses_overwrite(tmp_path, make_candidate):
    nodes_path = tmp_path / "nodes.json"
    nodes_path.write_text(json.dumps(_store_nodes(["some prior idea text"])), encoding="utf-8")
    candidates_path = tmp_path / "candidates.json"
    candidates_path.write_text(json.dumps([make_candidate()]), encoding="utf-8")

    out_a = tmp_path / "a.json"
    out_b = tmp_path / "b.json"
    assert dedup_check.run(["--nodes", str(nodes_path), "--candidates", str(candidates_path), "--out", str(out_a)]) == 0
    assert dedup_check.run(["--nodes", str(nodes_path), "--candidates", str(candidates_path), "--out", str(out_b)]) == 0
    assert out_a.read_bytes() == out_b.read_bytes()
    assert dedup_check.run(["--nodes", str(nodes_path), "--candidates", str(candidates_path), "--out", str(out_a)]) == 2


def test_dedup_compares_within_the_burst(tmp_path, make_candidate):
    """Two identical candidates in one burst: the second must see the first."""
    nodes_path = tmp_path / "nodes.json"
    nodes_path.write_text(json.dumps(_store_nodes(["a completely unrelated prior idea"])), encoding="utf-8")
    candidates_path = tmp_path / "candidates.json"
    candidates_path.write_text(json.dumps([make_candidate(), make_candidate()]), encoding="utf-8")
    out_path = tmp_path / "report.json"
    assert dedup_check.run(["--nodes", str(nodes_path), "--candidates", str(candidates_path), "--out", str(out_path)]) == 0
    report = json.loads(out_path.read_text(encoding="utf-8"))
    first, second = report["results"]
    assert first["decision"] == "unique"
    assert second["decision"] == "auto_drop"
    assert second["intra_burst_neighbor_index"] == 0
    assert second["nearest_similarity"] == 1.0  # exact normalized-text short-circuit


def test_dedup_rejects_degenerate_dim(tmp_path, make_candidate):
    nodes_path = tmp_path / "nodes.json"
    nodes_path.write_text(json.dumps(_store_nodes(["x"])), encoding="utf-8")
    candidates_path = tmp_path / "candidates.json"
    candidates_path.write_text(json.dumps([make_candidate()]), encoding="utf-8")
    for dim in ("0", "-4", "63"):
        assert dedup_check.run([
            "--nodes", str(nodes_path), "--candidates", str(candidates_path),
            "--out", str(tmp_path / f"r{dim}.json"), "--dim", dim,
        ]) == 2


def test_dedup_accepts_wrapped_store_shape(tmp_path, make_candidate):
    wrapped = {"campaign_id": "cmpn0001", "nodes": _store_nodes(["anything"])}
    nodes_path = tmp_path / "nodes.json"
    nodes_path.write_text(json.dumps(wrapped), encoding="utf-8")
    candidates_path = tmp_path / "candidates.json"
    candidates_path.write_text(json.dumps([make_candidate()]), encoding="utf-8")
    out_path = tmp_path / "report.json"
    assert dedup_check.run(["--nodes", str(nodes_path), "--candidates", str(candidates_path), "--out", str(out_path)]) == 0


# ---------------------------------------------------------------------------
# build_pack — validation mirror (unit level)
# ---------------------------------------------------------------------------

def _problems(candidate):
    return build_pack.validate_candidate(candidate, 0)


def test_valid_candidate_has_no_problems(make_candidate):
    assert _problems(make_candidate()) == []


def test_unknown_family_and_arity_violations(make_candidate):
    candidate = make_candidate()
    candidate["provenance"]["operator_family"] = "IslandEvolution"
    assert any("unknown operator_family" in p for p in _problems(candidate))

    candidate = make_candidate()
    candidate["provenance"]["operator_family"] = "Mutation"
    assert any("exactly 1 parents" in p for p in _problems(candidate))

    candidate = make_candidate()
    candidate["provenance"]["operator_family"] = "Recombination"
    candidate["provenance"]["parent_node_ids"] = ["nd000001"]
    assert any("at least 2 parents" in p for p in _problems(candidate))

    candidate = make_candidate()
    candidate["provenance"]["operator_family"] = "AnalogyTransfer"
    assert any("analogy_mapping" in p for p in _problems(candidate))


def test_reserved_trace_keys_are_rejected(make_candidate):
    candidate = make_candidate()
    candidate["provenance"]["trace_inputs"]["trigger"] = {"kind": "manual"}
    assert any("engine-owned" in p for p in _problems(candidate))

    candidate = make_candidate()
    candidate["provenance"]["trace_params"]["formalization"] = {"mode": "spoofed"}
    assert any("formalization is engine-owned" in p for p in _problems(candidate))


def test_receipt_coverage_and_placeholder_ban(make_candidate):
    candidate = make_candidate()
    candidate["provenance"]["evidence_uris_used"] = [candidate["provenance"]["evidence_uris_used"][0]]
    assert any("not listed in evidence_uris_used" in p for p in _problems(candidate))

    candidate = make_candidate()
    candidate["provenance"]["trace_inputs"]["retrieval_receipts"].pop()
    assert any("no retrieval receipt" in p for p in _problems(candidate))

    candidate = make_candidate()
    candidate["provenance"]["evidence_uris_used"].append(build_pack.PLACEHOLDER_EVIDENCE_URI)
    assert any("placeholder" in p for p in _problems(candidate))


def test_anchor_rules_tension_and_gap(make_candidate):
    candidate = make_candidate()
    del candidate["provenance"]["trace_inputs"]["anchor"]
    assert any("requires trace_inputs.anchor" in p for p in _problems(candidate))

    candidate = make_candidate()
    candidate["provenance"]["trace_inputs"]["anchor"] = {"kind": "gap", "statement": "nothing measured under Z"}
    assert any("no resolved references, no gap idea" in p for p in _problems(candidate))

    candidate = make_candidate()
    candidate["provenance"]["trace_inputs"]["anchor"] = {
        "kind": "gap",
        "resolved_refs": ["https://example.com/paper-c"],
        "statement": "nothing measured under Z",
    }
    assert any("no retrieval receipt" in p for p in _problems(candidate))

    candidate = make_candidate()
    candidate["provenance"]["trace_inputs"]["anchor"] = {
        "kind": "gap",
        "resolved_refs": ["https://example.com/paper-a"],
        "statement": "nothing measured under Z",
    }
    assert _problems(candidate) == []


def test_failure_routing_requires_ledger_refs_when_parentless(make_candidate):
    candidate = make_candidate()
    candidate["provenance"]["operator_family"] = "FailureRouting"
    assert any("failed_approach_refs" in p for p in _problems(candidate))

    candidate["provenance"]["trace_inputs"]["failed_approach_refs"] = ["file:///ledger#entry-3"]
    assert _problems(candidate) == []


def test_non_novel_delta_types_are_rejected(make_candidate):
    for delta_type in build_pack.NON_NOVEL_DELTA_TYPES:
        candidate = make_candidate()
        candidate["novelty_delta"]["delta_type"] = delta_type
        assert any("non-novel by construction" in p for p in _problems(candidate))


def _pinned_snapshot():
    return {
        "survey_artifact_ref": "file:///tmp/survey.json",
        "survey_content_hash": "sha256:" + "c" * 64,
    }


def test_pack_shape_gates_triggers_and_parent_revisions(make_candidate, prompt_snapshot):
    pack = {
        "campaign_id": "cmpn0001",
        "candidates": [make_candidate()],
        "evidence_snapshot": _pinned_snapshot(),
        "trigger": {"artifact_ref": "file:///tmp/match.json", "kind": "match_concluded"},
    }
    problems = build_pack.validate_pack_shape(pack, {})
    assert any("reserved vocabulary" in p for p in problems)

    pack["trigger"] = {"kind": "survey_updated"}
    problems = build_pack.validate_pack_shape(pack, {})
    assert any("require trigger.artifact_ref" in p for p in problems)

    # LiteratureMining requires the survey snapshot to be pinned
    unpinned = {
        "campaign_id": "cmpn0001",
        "candidates": [make_candidate()],
        "evidence_snapshot": {},
        "trigger": {"kind": "manual"},
    }
    problems = build_pack.validate_pack_shape(unpinned, {})
    assert any("pinning the mined survey" in p for p in problems)

    # parented FailureRouting exercises parent_revisions coverage
    text, snapshot_hash = prompt_snapshot
    candidate = make_candidate()
    candidate["provenance"]["operator_family"] = "FailureRouting"
    candidate["provenance"]["parent_node_ids"] = ["nd000001"]
    candidate["provenance"]["prompt_snapshot_hash"] = snapshot_hash
    pack = {
        "campaign_id": "cmpn0001",
        "candidates": [candidate],
        "evidence_snapshot": {},
        "prompt_snapshots": [{"content": text, "hash": snapshot_hash}],
        "trigger": {"kind": "manual"},
    }
    problems = build_pack.validate_pack_shape(pack, {})
    assert any("missing from parent_revisions" in p for p in problems)
    assert build_pack.validate_pack_shape(pack, {"nd000001": 1}) == []

    # mandatory prompt provenance: dropping the snapshot backing is a problem
    del pack["prompt_snapshots"]
    problems = build_pack.validate_pack_shape(pack, {"nd000001": 1})
    assert any("prompt_snapshot" in p for p in problems)

    # parentless FailureRouting refs must be pinned in the evidence snapshot
    unpinned = make_candidate()
    unpinned["provenance"]["operator_family"] = "FailureRouting"
    unpinned["provenance"]["prompt_snapshot_hash"] = snapshot_hash
    unpinned["provenance"]["trace_inputs"]["failed_approach_refs"] = ["file:///ledger#entry-3"]
    pack2 = {
        "campaign_id": "cmpn0001",
        "candidates": [unpinned],
        "evidence_snapshot": {},
        "prompt_snapshots": [{"content": text, "hash": snapshot_hash}],
        "trigger": {"kind": "manual"},
    }
    problems = build_pack.validate_pack_shape(pack2, {})
    assert any("not pinned in" in p for p in problems)
    pack2["evidence_snapshot"] = {"failed_approach_refs": ["file:///ledger#entry-3"]}
    assert build_pack.validate_pack_shape(pack2, {}) == []


def test_pack_shape_rejects_disabled_families_and_intra_pack_twins(make_candidate):
    disabled = make_candidate()
    disabled["provenance"]["operator_family"] = "Mutation"
    disabled["provenance"]["parent_node_ids"] = ["nd000001"]
    pack = {
        "campaign_id": "cmpn0001",
        "candidates": [disabled],
        "evidence_snapshot": {},
        "trigger": {"kind": "manual"},
    }
    problems = build_pack.validate_pack_shape(pack, {"nd000001": 1})
    assert any("not yet enabled for import" in p for p in problems)

    twins = {
        "campaign_id": "cmpn0001",
        "candidates": [make_candidate(), make_candidate()],
        "evidence_snapshot": _pinned_snapshot(),
        "trigger": {"kind": "manual"},
    }
    problems = build_pack.validate_pack_shape(twins, {})
    assert any("near-identical twins" in p for p in problems)


def test_new_receipt_and_consistency_mirrors(make_candidate):
    # rationale_draft.references need receipts
    candidate = make_candidate()
    candidate["rationale_draft"]["references"] = ["https://example.com/unfetched"]
    assert any("no retrieval receipt" in p or "not listed in evidence_uris_used" in p for p in _problems(candidate))

    # URI-shaped closest_prior needs a receipt; a ref_key does not
    candidate = make_candidate()
    candidate["novelty_delta"]["closest_prior"] = "https://example.com/never-retrieved"
    assert any("not listed in evidence_uris_used" in p for p in _problems(candidate))
    candidate = make_candidate()
    candidate["novelty_delta"]["closest_prior"] = "refA"
    assert _problems(candidate) == []

    # placeholder deep-scan reaches gap anchors
    candidate = make_candidate()
    candidate["provenance"]["trace_inputs"]["anchor"] = {
        "kind": "gap",
        "resolved_refs": [build_pack.PLACEHOLDER_EVIDENCE_URI],
        "statement": "an unanchored gap",
    }
    assert any("forbidden anywhere" in p for p in _problems(candidate))

    # self-contradictory dedup record
    candidate = make_candidate()
    candidate["dedup"] = {"decision": "unique", "method": "m", "nearest_similarity": 0.99}
    assert any("contradicts nearest_similarity" in p for p in _problems(candidate))


# ---------------------------------------------------------------------------
# build_pack — CLI assembly
# ---------------------------------------------------------------------------

def _snapshot_args(tmp_path, prompt_snapshot):
    """Write the fixture rendered prompt (whose hash the fixture candidates'
    origin.prompt_hash carries) and return the --prompt-snapshot args."""
    text, _ = prompt_snapshot
    path = tmp_path / "rendered_prompt.txt"
    path.write_text(text, encoding="utf-8")
    return ["--prompt-snapshot", str(path)]


def _write_inputs(tmp_path, candidates, decisions, make_report_extra=None):
    tmp_path.mkdir(parents=True, exist_ok=True)
    candidates_path = tmp_path / "candidates.json"
    candidates_path.write_text(json.dumps(candidates), encoding="utf-8")
    results = []
    for index, decision in enumerate(decisions):
        entry = {"candidate_index": index, "decision": decision, "nearest_similarity": 0.5}
        if decision in ("flagged", "auto_drop"):
            entry["nearest_neighbor_node_id"] = "nd000000"
            entry["nearest_similarity"] = 0.9 if decision == "flagged" else 0.99
        results.append(entry)
    report = {
        "artifact": "generation_dedup_report_v1",
        "drop_threshold": 0.95,
        "flag_threshold": 0.8,
        "method": dedup_check.DEDUP_METHOD,
        "results": results,
    }
    if make_report_extra:
        report.update(make_report_extra)
    report_path = tmp_path / "dedup_report.json"
    report_path.write_text(json.dumps(report), encoding="utf-8")
    return candidates_path, report_path


def test_build_pack_folds_dedup_and_records_drops(tmp_path, make_candidate, prompt_snapshot):
    candidates = [make_candidate(), make_candidate(), make_candidate()]
    candidates_path, report_path = _write_inputs(tmp_path, candidates, ["unique", "auto_drop", "flagged"])
    out_path = tmp_path / "pack.json"
    survey = tmp_path / "survey.json"
    survey.write_text("{}", encoding="utf-8")

    assert build_pack.run([
        "--campaign-id", "cmpn0001",
        "--candidates", str(candidates_path),
        "--dedup-report", str(report_path),
        "--trigger-kind", "survey_updated",
        "--trigger-artifact-ref", "file:///tmp/survey.json",
        "--survey-artifact-ref", "file:///tmp/survey.json",
        "--survey-file", str(survey),
        *_snapshot_args(tmp_path, prompt_snapshot),
        "--created-at", "2026-07-06T00:00:00Z",
        "--out", str(out_path),
    ]) == 0

    pack = json.loads(out_path.read_text(encoding="utf-8"))
    assert len(pack["candidates"]) == 1
    assert pack["candidates"][0]["dedup"]["decision"] == "unique"
    assert pack["candidates"][0]["dedup"]["method"] == dedup_check.DEDUP_METHOD
    assert len(pack["rejected_candidates"]) == 2
    reasons = " | ".join(r["reason"] for r in pack["rejected_candidates"])
    assert "auto-drop" in reasons and "no human override" in reasons
    assert pack["evidence_snapshot"]["survey_content_hash"].startswith("sha256:")
    assert pack["trigger"] == {"artifact_ref": "file:///tmp/survey.json", "kind": "survey_updated"}


def test_build_pack_override_imports_flagged_with_reason(tmp_path, make_candidate, prompt_snapshot):
    candidates = [make_candidate()]
    candidates_path, report_path = _write_inputs(tmp_path, candidates, ["flagged"])
    out_path = tmp_path / "pack.json"
    survey = tmp_path / "survey.json"
    survey.write_text("{}", encoding="utf-8")
    assert build_pack.run([
        "--campaign-id", "cmpn0001",
        "--candidates", str(candidates_path),
        "--dedup-report", str(report_path),
        "--trigger-kind", "manual",
        "--survey-artifact-ref", "file:///tmp/survey.json",
        "--survey-file", str(survey),
        *_snapshot_args(tmp_path, prompt_snapshot),
        "--override", "0=reviewed: shares the anchor but proposes the opposite mechanism",
        "--created-at", "2026-07-06T00:00:00Z",
        "--out", str(out_path),
    ]) == 0
    pack = json.loads(out_path.read_text(encoding="utf-8"))
    dedup = pack["candidates"][0]["dedup"]
    assert dedup["decision"] == "flagged"
    assert dedup["override_reason"].startswith("reviewed:")
    assert dedup["nearest_neighbor_node_id"] == "nd000000"


def test_build_pack_refuses_invalid_inputs(tmp_path, make_candidate):
    # all candidates rejected -> refuse
    candidates_path, report_path = _write_inputs(tmp_path, [make_candidate()], ["auto_drop"])
    assert build_pack.run([
        "--campaign-id", "cmpn0001",
        "--candidates", str(candidates_path),
        "--dedup-report", str(report_path),
        "--trigger-kind", "manual",
        "--out", str(tmp_path / "pack1.json"),
    ]) == 2

    # pre-filled dedup -> refuse
    prefilled = make_candidate()
    prefilled["dedup"] = {"decision": "unique", "method": "handwaved"}
    candidates_path2, report_path2 = _write_inputs(tmp_path / "b", [prefilled], ["unique"])
    assert build_pack.run([
        "--campaign-id", "cmpn0001",
        "--candidates", str(candidates_path2),
        "--dedup-report", str(report_path2),
        "--trigger-kind", "manual",
        "--out", str(tmp_path / "pack2.json"),
    ]) == 2

    # semantic violation -> refuse with problems
    bad = make_candidate()
    bad["novelty_delta"]["delta_type"] = "rewording"
    candidates_path3, report_path3 = _write_inputs(tmp_path / "c", [bad], ["unique"])
    assert build_pack.run([
        "--campaign-id", "cmpn0001",
        "--candidates", str(candidates_path3),
        "--dedup-report", str(report_path3),
        "--trigger-kind", "manual",
        "--out", str(tmp_path / "pack3.json"),
    ]) == 2


def test_build_pack_refuses_fail_open_paths(tmp_path, make_candidate, prompt_snapshot):
    survey = tmp_path / "survey.json"
    survey.write_text("{}", encoding="utf-8")
    base_args = [
        "--campaign-id", "cmpn0001",
        "--trigger-kind", "manual",
        "--survey-artifact-ref", "file:///tmp/survey.json",
        "--survey-file", str(survey),
        *_snapshot_args(tmp_path, prompt_snapshot),
        "--created-at", "2026-07-06T00:00:00Z",
    ]

    # unknown decision string must not fall through to "unique"
    candidates_path, report_path = _write_inputs(tmp_path / "a", [make_candidate()], ["unique"])
    report = json.loads(report_path.read_text(encoding="utf-8"))
    report["results"][0]["decision"] = "probably_fine"
    report_path.write_text(json.dumps(report), encoding="utf-8")
    assert build_pack.run(base_args + [
        "--candidates", str(candidates_path), "--dedup-report", str(report_path),
        "--out", str(tmp_path / "p1.json"),
    ]) == 2

    # misaligned candidate_index is refused (a reordered report drops the wrong candidate)
    candidates_path, report_path = _write_inputs(tmp_path / "b", [make_candidate()], ["unique"])
    report = json.loads(report_path.read_text(encoding="utf-8"))
    report["results"][0]["candidate_index"] = 5
    report_path.write_text(json.dumps(report), encoding="utf-8")
    assert build_pack.run(base_args + [
        "--candidates", str(candidates_path), "--dedup-report", str(report_path),
        "--out", str(tmp_path / "p2.json"),
    ]) == 2

    # an override that matches no flagged candidate is an error, not a no-op
    candidates_path, report_path = _write_inputs(tmp_path / "c", [make_candidate()], ["unique"])
    assert build_pack.run(base_args + [
        "--candidates", str(candidates_path), "--dedup-report", str(report_path),
        "--override", "0=this candidate was never flagged",
        "--out", str(tmp_path / "p3.json"),
    ]) == 2

    # malformed --rejected shape is a clean exit 2, not a traceback
    candidates_path, report_path = _write_inputs(tmp_path / "d", [make_candidate()], ["unique"])
    bad_rejected = tmp_path / "rejected.json"
    bad_rejected.write_text(json.dumps([{"summary": "no reason field"}]), encoding="utf-8")
    assert build_pack.run(base_args + [
        "--candidates", str(candidates_path), "--dedup-report", str(report_path),
        "--rejected", str(bad_rejected),
        "--out", str(tmp_path / "p4.json"),
    ]) == 2


def test_build_pack_prompt_snapshot_flow(tmp_path, make_candidate, prompt_snapshot):
    text, expected_hash = prompt_snapshot
    survey = tmp_path / "survey.json"
    survey.write_text("{}", encoding="utf-8")

    candidates_path, report_path = _write_inputs(tmp_path, [make_candidate()], ["unique"])
    out_path = tmp_path / "pack.json"
    assert build_pack.run([
        "--campaign-id", "cmpn0001",
        "--candidates", str(candidates_path),
        "--dedup-report", str(report_path),
        "--trigger-kind", "manual",
        "--survey-artifact-ref", "file:///tmp/survey.json",
        "--survey-file", str(survey),
        *_snapshot_args(tmp_path, prompt_snapshot),
        "--created-at", "2026-07-06T00:00:00Z",
        "--out", str(out_path),
    ]) == 0
    pack = json.loads(out_path.read_text(encoding="utf-8"))
    assert pack["prompt_snapshots"] == [{"content": text, "hash": expected_hash}]
    # single snapshot auto-fills candidates lacking a declared hash, and the
    # fixture's origin.prompt_hash matches by construction
    assert pack["candidates"][0]["provenance"]["prompt_snapshot_hash"] == expected_hash
    assert pack["candidates"][0]["provenance"]["origin"]["prompt_hash"] == expected_hash

    # omitting --prompt-snapshot is refused: prompt provenance is mandatory
    candidates_path2, report_path2 = _write_inputs(tmp_path / "nosnap", [make_candidate()], ["unique"])
    assert build_pack.run([
        "--campaign-id", "cmpn0001",
        "--candidates", str(candidates_path2),
        "--dedup-report", str(report_path2),
        "--trigger-kind", "manual",
        "--survey-artifact-ref", "file:///tmp/survey.json",
        "--survey-file", str(survey),
        "--created-at", "2026-07-06T00:00:00Z",
        "--out", str(tmp_path / "pack-nosnap.json"),
    ]) == 2


# ---------------------------------------------------------------------------
# submit_pack
# ---------------------------------------------------------------------------

def _minimal_pack(make_candidate, prompt_snapshot):
    text, snapshot_hash = prompt_snapshot
    candidate = make_candidate()
    candidate["dedup"] = {"decision": "unique", "method": dedup_check.DEDUP_METHOD}
    provenance = candidate["provenance"]
    provenance["prompt_snapshot_hash"] = snapshot_hash
    return {
        "campaign_id": "cmpn0001",
        "candidates": [candidate],
        "created_at": "2026-07-06T00:00:00Z",
        "evidence_snapshot": {},
        "prompt_snapshots": [{"content": text, "hash": snapshot_hash}],
        "rejected_candidates": [],
        "trigger": {"kind": "manual"},
    }


def test_submit_key_is_deterministic_and_content_sensitive(make_candidate, prompt_snapshot):
    pack = _minimal_pack(make_candidate, prompt_snapshot)
    key_a = submit_pack.deterministic_idempotency_key("cmpn0001", pack)
    key_b = submit_pack.deterministic_idempotency_key("cmpn0001", json.loads(json.dumps(pack)))
    assert key_a == key_b
    assert key_a.startswith("genpack-")
    # key-order independence must be exercised for real: same content, keys
    # inserted in a different order
    reordered = {key: pack[key] for key in sorted(pack.keys(), reverse=True)}
    assert list(reordered.keys()) != list(pack.keys())
    assert submit_pack.deterministic_idempotency_key("cmpn0001", reordered) == key_a
    changed = copy.deepcopy(pack)
    changed["trigger"] = {"kind": "manual", "artifact_ref": "file:///x"}
    assert submit_pack.deterministic_idempotency_key("cmpn0001", changed) != key_a


def test_submit_pins_the_request_shape_against_a_mock_bridge(tmp_path, make_candidate, prompt_snapshot, monkeypatch):
    pack = _minimal_pack(make_candidate, prompt_snapshot)
    pack_path = tmp_path / "pack.json"
    pack_path.write_text(json.dumps(pack), encoding="utf-8")
    capture = tmp_path / "captured.json"
    monkeypatch.setenv("MOCK_RPC_CAPTURE", str(capture))

    exit_code = submit_pack.run([
        "--pack", str(pack_path),
        "--campaign-id", "cmpn0001",
        "--store-root", "/tmp/store-root",
        "--idea-rpc", str(TESTS_DIR / "mock_rpc.py"),
        "--node-bin", sys.executable,
    ])
    assert exit_code == 0
    request = json.loads(capture.read_text(encoding="utf-8"))
    assert request["method"] == "node.import_generated"
    assert request["store_root"] == "/tmp/store-root"
    assert set(request["params"].keys()) == {"campaign_id", "idempotency_key", "pack"}
    assert request["params"]["campaign_id"] == "cmpn0001"
    assert request["params"]["idempotency_key"] == submit_pack.deterministic_idempotency_key("cmpn0001", pack)
    assert request["params"]["pack"] == pack


def test_submit_surfaces_engine_errors_and_campaign_mismatch(tmp_path, make_candidate, prompt_snapshot, monkeypatch):
    pack = _minimal_pack(make_candidate, prompt_snapshot)
    pack_path = tmp_path / "pack.json"
    pack_path.write_text(json.dumps(pack), encoding="utf-8")

    assert submit_pack.run([
        "--pack", str(pack_path),
        "--campaign-id", "zzzzzzzz",
        "--store-root", "/tmp/store-root",
        "--idea-rpc", str(TESTS_DIR / "mock_rpc.py"),
        "--node-bin", sys.executable,
    ]) == 2

    monkeypatch.setenv("MOCK_RPC_ERROR", "1")
    assert submit_pack.run([
        "--pack", str(pack_path),
        "--campaign-id", "cmpn0001",
        "--store-root", "/tmp/store-root",
        "--idea-rpc", str(TESTS_DIR / "mock_rpc.py"),
        "--node-bin", sys.executable,
    ]) == 1


# ---------------------------------------------------------------------------
# anti-drift locks against the ENGINE contract (read at test time)
# ---------------------------------------------------------------------------

def test_enum_mirrors_match_engine_generation_pack_contract(engine_contract_dir):
    schema = json.loads((engine_contract_dir / "generation_pack_v1.schema.json").read_text(encoding="utf-8"))
    trigger_enum = schema["properties"]["trigger"]["properties"]["kind"]["enum"]
    assert trigger_enum == build_pack.TRIGGER_VOCABULARY
    candidate = schema["$defs"]["candidate"]["properties"]
    assert candidate["novelty_delta"]["properties"]["delta_type"]["enum"] == build_pack.DELTA_TYPES
    assert candidate["target_admission_route"]["enum"] == build_pack.ADMISSION_ROUTES
    node_schema = json.loads((engine_contract_dir / "idea_node_v1.schema.json").read_text(encoding="utf-8"))
    assert schema["properties"]["campaign_id"]["pattern"] == node_schema["properties"]["campaign_id"]["pattern"]
    assert set(build_pack.ENABLED_TRIGGER_KINDS) <= set(build_pack.TRIGGER_VOCABULARY)


def _ts_const_strings(source, marker):
    block_start = source.index(marker)
    block = source[block_start:source.index(";", block_start)]
    return re.findall(r"'([^']+)'", block)


def test_enabled_triggers_and_family_table_match_engine_executor(engine_src_dir):
    executor = (engine_src_dir / "service" / "import-generated-executor.ts").read_text(encoding="utf-8")
    enabled = _ts_const_strings(executor, "const ENABLED_TRIGGER_KINDS")
    assert enabled == build_pack.ENABLED_TRIGGER_KINDS
    enabled_families = _ts_const_strings(executor, "const ENABLED_OPERATOR_FAMILIES")
    assert enabled_families == build_pack.ENABLED_FAMILIES

    arity_start = executor.index("const OPERATOR_FAMILY_ARITY")
    arity_block = executor[arity_start:executor.index("};", arity_start)]
    # Lock the arity VALUES, not just the family names: an engine arity change
    # must fail here rather than drift silently into build_pack's exit-2 gate.
    engine_arity = {}
    for family, body in re.findall(r"^\s{2}(\w+): \{ ([^}]*) \},?$", arity_block, flags=re.MULTILINE):
        engine_arity[family] = {
            key: int(value) for key, value in re.findall(r"(exact|min|max): (\d+)", body)
        }
    assert engine_arity == build_pack.FAMILY_ARITY

    bound = re.search(r"const DEDUP_AUTO_DROP_BOUND = ([0-9.]+)", executor)
    assert bound and float(bound.group(1)) == build_pack.DEDUP_AUTO_DROP_BOUND

    non_novel = _ts_const_strings(executor, "const NON_NOVEL_DELTA_TYPES")
    assert sorted(non_novel) == sorted(build_pack.NON_NOVEL_DELTA_TYPES)

    reserved = _ts_const_strings(executor, "const RESERVED_TRACE_INPUT_KEYS")
    assert reserved == build_pack.RESERVED_TRACE_INPUT_KEYS

    shared = (engine_src_dir / "service" / "node-shared.ts").read_text(encoding="utf-8")
    assert f"'{build_pack.PLACEHOLDER_EVIDENCE_URI}'" in shared


def test_submit_reaches_the_real_engine_bridge(tmp_path, make_candidate, prompt_snapshot):
    """End-to-end through bin/idea-rpc.mjs and the built engine (skipped when
    node or the engine dist is absent, e.g. standalone skill installs)."""
    import shutil
    repo_root = SKILL_ROOT.parents[1]
    idea_rpc = repo_root / "packages" / "idea-engine" / "bin" / "idea-rpc.mjs"
    dist = repo_root / "packages" / "idea-engine" / "dist" / "index.js"
    node_bin = shutil.which("node")
    if not (idea_rpc.is_file() and dist.is_file() and node_bin):
        pytest.skip("node or the built idea-engine is not available")

    store_root = tmp_path / "store"
    init_request = {
        "method": "campaign.init",
        "params": {
            "budget": {"max_cost_usd": 10, "max_nodes": 10, "max_steps": 10, "max_tokens": 1000, "max_wall_clock_s": 1000},
            "charter": {
                "approval_gate_ref": "gate://a0.1",
                "campaign_name": "bridge-smoke",
                "domain": "test-domain",
                "scope": "real-bridge submit integration test",
            },
            "idempotency_key": "init",
            "seed_pack": {"seeds": [{"content": "seed", "seed_type": "text", "source_uris": ["https://example.com/s"]}]},
        },
        "store_root": str(store_root),
    }
    completed = subprocess.run(
        [node_bin, str(idea_rpc)], capture_output=True, check=True,
        input=json.dumps(init_request).encode("utf-8"), timeout=60,
    )
    campaign_id = json.loads(completed.stdout.decode("utf-8"))["result"]["campaign_id"]

    pack = _minimal_pack(make_candidate, prompt_snapshot)
    pack["campaign_id"] = campaign_id
    pack["evidence_snapshot"] = {
        "survey_artifact_ref": "file:///tmp/survey.json",
        "survey_content_hash": "sha256:" + "c" * 64,
    }
    pack_path = tmp_path / "pack.json"
    pack_path.write_text(json.dumps(pack), encoding="utf-8")
    exit_code = submit_pack.run([
        "--pack", str(pack_path),
        "--campaign-id", campaign_id,
        "--store-root", str(store_root),
        "--idea-rpc", str(idea_rpc),
        "--node-bin", node_bin,
    ])
    assert exit_code == 0
    nodes = json.loads((store_root / "campaigns" / campaign_id / "nodes_latest.json").read_text(encoding="utf-8"))
    generated = [n for n in nodes.values() if n.get("operator_family") == "LiteratureMining"]
    assert len(generated) == 1
