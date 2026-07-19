"""Tests for the production launch authorization preflight (A3 machine gate).

One positive control (everything consistent -> authorized) and one negative
control per mismatch class: missing plan hash, plan edited after review,
missing review verdict, rejecting reviewer, unavailable reviewer, and
fingerprint mismatch — plus record-validation and discipline edge cases.
"""
from __future__ import annotations

import hashlib
import importlib.util
import json
from pathlib import Path

_MOD = Path(__file__).resolve().parent.parent / "scripts" / "check_launch_authorization.py"
_spec = importlib.util.spec_from_file_location("check_launch_authorization", _MOD)
la = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(la)

_SCHEMA = (Path(__file__).resolve().parents[3]
           / "meta" / "schemas" / "launch_authorization_v1.schema.json")

PLAN_TEXT = "production plan: run the full-scale computation on the frozen configuration\n"
FINGERPRINT = {"code_commit": "0123abcd", "solver_version": "9.9.1",
               "dependency_lock_sha256": "f" * 64}


def _sha(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def _write_json(path: Path, doc) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(doc, indent=2), encoding="utf-8")


def _verdict_doc(reviewer: str, verdict: str, bound_sha: "str | None") -> dict:
    doc = {"verdict_version": 1, "reviewer": reviewer, "verdict": verdict}
    if bound_sha is not None:
        doc["reviewed_plan_sha256"] = bound_sha
    return doc


def _project(tmp_path: Path, *, plan_text: str = PLAN_TEXT,
             reviews: "list[tuple[str, str, str | None]] | None" = None,
             required_approvals: int = 1,
             observed: "dict | None" = None) -> dict:
    """Build a consistent project: plan file, authorization record, one
    verdict file per (reviewer, verdict, bound_sha) triple, observed
    fingerprint. Tests then break exactly one leg."""
    root = tmp_path / "project"
    root.mkdir(exist_ok=True)
    (root / "plan.md").write_text(plan_text, encoding="utf-8")
    plan_sha = _sha(plan_text)
    if reviews is None:
        reviews = [("reviewer-one", "approved", plan_sha)]
    for reviewer, verdict, bound in reviews:
        _write_json(root / "reviews" / f"{reviewer}.json",
                    _verdict_doc(reviewer, verdict, bound))
    record = {
        "record_version": 1,
        "plan_path": "plan.md",
        "plan_sha256": plan_sha,
        "required_approvals": required_approvals,
        "reviews": [{"reviewer": reviewer, "verdict_path": f"reviews/{reviewer}.json"}
                    for reviewer, _, _ in reviews],
        "environment_fingerprint": dict(FINGERPRINT),
    }
    _write_json(root / "launch_authorization_record.json", record)
    observed_path = tmp_path / "observed_fingerprint.json"
    _write_json(observed_path, dict(FINGERPRINT) if observed is None else observed)
    return {"root": root, "plan_sha": plan_sha,
            "record_path": root / "launch_authorization_record.json",
            "observed_path": observed_path}


def _run(proj: dict, capsys, extra_args: "list[str] | None" = None) -> "tuple[int, dict]":
    argv = ["--record", str(proj["record_path"]),
            "--observed-fingerprint", str(proj["observed_path"]),
            "--project-root", str(proj["root"])]
    if extra_args:
        argv.extend(extra_args)
    code = la.main(argv)
    out = capsys.readouterr().out
    return code, json.loads(out)


def _check_status(result: dict, check_id: str) -> str:
    return next(c["status"] for c in result["checks"] if c["check_id"] == check_id)


# --- positive control ---

def test_authorized_when_all_preconditions_hold(tmp_path, capsys):
    proj = _project(tmp_path)
    code, result = _run(proj, capsys)
    assert code == 0
    assert result["verdict"] == "authorized"
    assert result["launch_authorized"] is True
    assert result["exit_code"] == 0
    assert result["approvals_counted"] == 1
    assert all(c["status"] == "pass" for c in result["checks"])
    assert result["plan"]["live_sha256"] == proj["plan_sha"]
    assert result["fingerprint"]["equal"] is True


# --- negative control 1: missing plan hash / plan file ---

def test_refuses_missing_plan_file(tmp_path, capsys):
    proj = _project(tmp_path)
    (proj["root"] / "plan.md").unlink()
    code, result = _run(proj, capsys)
    assert code == 3
    assert result["verdict"] == "missing_plan_hash"
    assert result["launch_authorized"] is False
    assert _check_status(result, "plan_frozen") == "fail"
    # no live hash -> review binding cannot be evaluated, and that is not a pass
    assert _check_status(result, "review_binding") == "not_evaluated"
    # the fingerprint check is independent and still audited
    assert _check_status(result, "fingerprint_match") == "pass"


# --- negative control 2: plan edited after authorization/review ---

def test_refuses_stale_review_when_plan_edited_after_authorization(tmp_path, capsys):
    proj = _project(tmp_path)
    (proj["root"] / "plan.md").write_text(PLAN_TEXT + "one silent late edit\n",
                                          encoding="utf-8")
    code, result = _run(proj, capsys)
    assert code == 3
    assert result["verdict"] == "stale_review"
    assert result["launch_authorized"] is False
    assert _check_status(result, "plan_frozen") == "fail"


def test_refuses_stale_review_when_approval_bound_to_other_hash(tmp_path, capsys):
    # plan matches the record, but the approval was for a different plan version
    proj = _project(tmp_path, reviews=[("reviewer-one", "approved", "a" * 64)])
    code, result = _run(proj, capsys)
    assert code == 3
    assert result["verdict"] == "stale_review"
    assert _check_status(result, "plan_frozen") == "pass"
    assert _check_status(result, "review_binding") == "fail"
    assert result["approvals_counted"] == 0
    assert result["reviews"][0]["counts_as_approval"] is False


# --- negative control 3: missing review verdict ---

def test_refuses_missing_review_verdict(tmp_path, capsys):
    proj = _project(tmp_path)
    (proj["root"] / "reviews" / "reviewer-one.json").unlink()
    code, result = _run(proj, capsys)
    assert code == 3
    assert result["verdict"] == "missing_review"
    assert result["reviews"][0]["verdict"] == "missing"
    assert result["approvals_counted"] == 0


# --- negative control 4: reviewer rejected ---

def test_refuses_review_rejected(tmp_path, capsys):
    proj = _project(tmp_path)
    plan_sha = proj["plan_sha"]
    _write_json(proj["root"] / "reviews" / "reviewer-one.json",
                _verdict_doc("reviewer-one", "changes_needed", plan_sha))
    code, result = _run(proj, capsys)
    assert code == 3
    assert result["verdict"] == "review_rejected"
    assert result["approvals_counted"] == 0


# --- negative control 5: reviewer unavailable is never approval ---

def test_refuses_reviewer_unavailable(tmp_path, capsys):
    proj = _project(tmp_path, reviews=[("reviewer-one", "unavailable", None)])
    code, result = _run(proj, capsys)
    assert code == 3
    assert result["verdict"] == "reviewer_unavailable"
    assert result["launch_authorized"] is False
    assert result["reviews"][0]["counts_as_approval"] is False
    assert result["approvals_counted"] == 0


# --- negative control 6: fingerprint mismatch ---

def test_refuses_fingerprint_value_mismatch(tmp_path, capsys):
    observed = dict(FINGERPRINT, solver_version="9.9.2")
    proj = _project(tmp_path, observed=observed)
    code, result = _run(proj, capsys)
    assert code == 3
    assert result["verdict"] == "fingerprint_mismatch"
    assert result["fingerprint"]["equal"] is False
    assert result["fingerprint"]["mismatched_keys"] == ["solver_version"]


def test_refuses_fingerprint_extra_observed_key(tmp_path, capsys):
    # symmetric strictness: an extra key on the observed side also refuses
    observed = dict(FINGERPRINT, extra_component="1.0")
    proj = _project(tmp_path, observed=observed)
    code, result = _run(proj, capsys)
    assert code == 3
    assert result["verdict"] == "fingerprint_mismatch"
    assert result["fingerprint"]["mismatched_keys"] == ["extra_component"]


def test_refuses_missing_observed_fingerprint(tmp_path, capsys):
    proj = _project(tmp_path)
    proj["observed_path"].unlink()
    code, result = _run(proj, capsys)
    assert code == 3
    assert result["verdict"] == "fingerprint_mismatch"


# --- discipline edges ---

def test_unavailability_does_not_veto_a_met_quorum(tmp_path, capsys):
    # quorum 1 met by a genuine bound approval; a second listed reviewer is
    # unavailable — never counted as approval, but not a veto either
    proj = _project(tmp_path, reviews=[
        ("reviewer-one", "approved", _sha(PLAN_TEXT)),
        ("reviewer-two", "unavailable", None),
    ], required_approvals=1)
    code, result = _run(proj, capsys)
    assert code == 0
    assert result["verdict"] == "authorized"
    assert result["approvals_counted"] == 1


def test_unbound_approval_never_counts(tmp_path, capsys):
    # an approval that does not state which plan hash it reviewed is not
    # an approval
    proj = _project(tmp_path, reviews=[("reviewer-one", "approved", None)])
    code, result = _run(proj, capsys)
    assert code == 3
    assert result["verdict"] == "missing_review"
    assert result["reviews"][0]["verdict"] == "invalid"


def test_verdict_file_for_wrong_reviewer_never_counts(tmp_path, capsys):
    proj = _project(tmp_path)
    _write_json(proj["root"] / "reviews" / "reviewer-one.json",
                _verdict_doc("someone-else", "approved", proj["plan_sha"]))
    code, result = _run(proj, capsys)
    assert code == 3
    assert result["verdict"] == "missing_review"
    assert result["reviews"][0]["verdict"] == "invalid"


def test_stale_outranks_rejected_and_unavailable(tmp_path, capsys):
    proj = _project(tmp_path, reviews=[
        ("reviewer-one", "approved", "b" * 64),
        ("reviewer-two", "changes_needed", _sha(PLAN_TEXT)),
        ("reviewer-three", "unavailable", None),
    ], required_approvals=1)
    code, result = _run(proj, capsys)
    assert code == 3
    assert result["verdict"] == "stale_review"


def test_quorum_requires_all_required_approvals(tmp_path, capsys):
    plan_sha = _sha(PLAN_TEXT)
    proj = _project(tmp_path, reviews=[
        ("reviewer-one", "approved", plan_sha),
        ("reviewer-two", "unavailable", None),
    ], required_approvals=2)
    code, result = _run(proj, capsys)
    assert code == 3
    assert result["verdict"] == "reviewer_unavailable"
    assert result["approvals_counted"] == 1


def test_stale_surplus_approval_does_not_veto_met_quorum(tmp_path, capsys):
    # Deliberate semantics, same principle as unavailable-not-veto: a verdict
    # bound to a superseded hash is void — it never counts as approval, and it
    # does not veto a quorum already met by approvals bound to the live plan.
    # The declared quorum is the requirement.
    proj = _project(tmp_path, reviews=[
        ("reviewer-one", "approved", _sha(PLAN_TEXT)),
        ("reviewer-two", "approved", "c" * 64),
    ], required_approvals=1)
    code, result = _run(proj, capsys)
    assert code == 0
    assert result["verdict"] == "authorized"
    assert result["approvals_counted"] == 1
    stale_entry = next(r for r in result["reviews"] if r["reviewer"] == "reviewer-two")
    assert stale_entry["counts_as_approval"] is False


def test_stale_approval_blocks_when_quorum_needs_it(tmp_path, capsys):
    plan_sha = _sha(PLAN_TEXT)
    proj = _project(tmp_path, reviews=[
        ("reviewer-one", "approved", plan_sha),
        ("reviewer-two", "approved", "c" * 64),
    ], required_approvals=2)
    code, result = _run(proj, capsys)
    assert code == 3
    assert result["verdict"] == "stale_review"


# --- crash-free labeled refusals on hostile inputs ---

def test_boolean_record_version_is_invalid(tmp_path, capsys):
    # bool == 1 in Python; version fields must be exactly the integer 1
    proj = _project(tmp_path)
    record = json.loads(proj["record_path"].read_text(encoding="utf-8"))
    record["record_version"] = True
    _write_json(proj["record_path"], record)
    code, result = _run(proj, capsys)
    assert code == 2
    assert result["verdict"] == "invalid_record"


def test_wrong_record_version_is_invalid(tmp_path, capsys):
    proj = _project(tmp_path)
    record = json.loads(proj["record_path"].read_text(encoding="utf-8"))
    record["record_version"] = 2
    _write_json(proj["record_path"], record)
    code, result = _run(proj, capsys)
    assert code == 2
    assert result["verdict"] == "invalid_record"


def test_boolean_verdict_version_never_counts(tmp_path, capsys):
    proj = _project(tmp_path)
    doc = _verdict_doc("reviewer-one", "approved", proj["plan_sha"])
    doc["verdict_version"] = True
    _write_json(proj["root"] / "reviews" / "reviewer-one.json", doc)
    code, result = _run(proj, capsys)
    assert code == 3
    assert result["verdict"] == "missing_review"
    assert result["reviews"][0]["verdict"] == "invalid"


def test_nul_byte_in_plan_path_is_invalid_record(tmp_path, capsys):
    proj = _project(tmp_path)
    record = json.loads(proj["record_path"].read_text(encoding="utf-8"))
    record["plan_path"] = "plan\x00.md"
    _write_json(proj["record_path"], record)
    code, result = _run(proj, capsys)
    assert code == 2
    assert result["verdict"] == "invalid_record"


def test_absolute_plan_path_is_invalid_record(tmp_path, capsys):
    proj = _project(tmp_path)
    record = json.loads(proj["record_path"].read_text(encoding="utf-8"))
    record["plan_path"] = str(proj["root"] / "plan.md")
    _write_json(proj["record_path"], record)
    code, result = _run(proj, capsys)
    assert code == 2
    assert result["verdict"] == "invalid_record"


def test_deeply_nested_record_refuses_with_labeled_artifact(tmp_path, capsys):
    proj = _project(tmp_path)
    proj["record_path"].write_text("[" * 100000 + "]" * 100000, encoding="utf-8")
    code, result = _run(proj, capsys)
    assert code == 2
    assert result["verdict"] == "invalid_record"


def test_deeply_nested_observed_fingerprint_refuses(tmp_path, capsys):
    proj = _project(tmp_path)
    proj["observed_path"].write_text("[" * 100000 + "]" * 100000, encoding="utf-8")
    code, result = _run(proj, capsys)
    assert code == 3
    assert result["verdict"] == "fingerprint_mismatch"


def test_non_utf8_verdict_file_never_counts(tmp_path, capsys):
    proj = _project(tmp_path)
    (proj["root"] / "reviews" / "reviewer-one.json").write_bytes(b"\xff\xfe junk")
    code, result = _run(proj, capsys)
    assert code == 3
    assert result["verdict"] == "missing_review"
    assert result["reviews"][0]["verdict"] == "invalid"


def test_verdict_file_list_root_never_counts(tmp_path, capsys):
    proj = _project(tmp_path)
    (proj["root"] / "reviews" / "reviewer-one.json").write_text("[1, 2]", encoding="utf-8")
    code, result = _run(proj, capsys)
    assert code == 3
    assert result["verdict"] == "missing_review"
    assert result["reviews"][0]["verdict"] == "invalid"


def test_verdict_path_directory_never_counts(tmp_path, capsys):
    proj = _project(tmp_path)
    (proj["root"] / "reviews" / "reviewer-one.json").unlink()
    (proj["root"] / "reviews" / "reviewer-one.json").mkdir()
    code, result = _run(proj, capsys)
    assert code == 3
    assert result["verdict"] == "missing_review"
    assert result["reviews"][0]["verdict"] == "missing"


def test_non_string_observed_value_refuses_and_result_stays_schema_clean(tmp_path, capsys):
    observed = dict(FINGERPRINT, solver_version=9)
    proj = _project(tmp_path, observed=observed)
    code, result = _run(proj, capsys)
    assert code == 3
    assert result["verdict"] == "fingerprint_mismatch"
    assert "solver_version" in result["fingerprint"]["mismatched_keys"]
    # the echoed observed object must satisfy the result schema (string
    # values only), so a non-string-valued observation is left null
    assert result["fingerprint"]["observed"] is None


def test_failed_output_write_refuses_even_when_authorized(tmp_path, capsys):
    proj = _project(tmp_path)
    blocker = tmp_path / "blocker"
    blocker.write_text("a regular file where a directory is needed", encoding="utf-8")
    code, result = _run(proj, capsys,
                        extra_args=["--output", str(blocker / "out.json")])
    # stdout still carries the full artifact (verdict authorized), but an
    # authorization whose requested audit artifact cannot be persisted is
    # refused with exit 2
    assert code == 2
    assert result["verdict"] == "authorized"


# --- invalid record (exit 2) ---

def test_invalid_record_missing_plan_hash_field(tmp_path, capsys):
    proj = _project(tmp_path)
    record = json.loads(proj["record_path"].read_text(encoding="utf-8"))
    del record["plan_sha256"]
    _write_json(proj["record_path"], record)
    code, result = _run(proj, capsys)
    assert code == 2
    assert result["verdict"] == "invalid_record"
    assert all(c["status"] == "not_evaluated" for c in result["checks"])


def test_invalid_record_impossible_quorum(tmp_path, capsys):
    proj = _project(tmp_path, required_approvals=1)
    record = json.loads(proj["record_path"].read_text(encoding="utf-8"))
    record["required_approvals"] = 5
    _write_json(proj["record_path"], record)
    code, result = _run(proj, capsys)
    assert code == 2
    assert result["verdict"] == "invalid_record"


def test_invalid_record_duplicate_reviewer(tmp_path, capsys):
    proj = _project(tmp_path)
    record = json.loads(proj["record_path"].read_text(encoding="utf-8"))
    record["reviews"].append(dict(record["reviews"][0]))
    _write_json(proj["record_path"], record)
    code, result = _run(proj, capsys)
    assert code == 2
    assert result["verdict"] == "invalid_record"


def test_invalid_record_empty_fingerprint(tmp_path, capsys):
    proj = _project(tmp_path)
    record = json.loads(proj["record_path"].read_text(encoding="utf-8"))
    record["environment_fingerprint"] = {}
    _write_json(proj["record_path"], record)
    code, result = _run(proj, capsys)
    assert code == 2
    assert result["verdict"] == "invalid_record"


def test_invalid_record_non_string_fingerprint_value(tmp_path, capsys):
    proj = _project(tmp_path)
    record = json.loads(proj["record_path"].read_text(encoding="utf-8"))
    record["environment_fingerprint"]["grid_points"] = 128
    _write_json(proj["record_path"], record)
    code, result = _run(proj, capsys)
    assert code == 2
    assert result["verdict"] == "invalid_record"


def test_invalid_record_path_escape(tmp_path, capsys):
    proj = _project(tmp_path)
    record = json.loads(proj["record_path"].read_text(encoding="utf-8"))
    record["plan_path"] = "../outside_plan.md"
    _write_json(proj["record_path"], record)
    code, result = _run(proj, capsys)
    assert code == 2
    assert result["verdict"] == "invalid_record"


def test_invalid_record_unreadable(tmp_path, capsys):
    proj = _project(tmp_path)
    proj["record_path"].write_bytes(b"\xff\xfe not json")
    code, result = _run(proj, capsys)
    assert code == 2
    assert result["verdict"] == "invalid_record"


# --- output artifact + contract alignment ---

def test_output_artifact_matches_stdout(tmp_path, capsys):
    proj = _project(tmp_path)
    out_path = tmp_path / "result" / "launch_authorization.json"
    code, result = _run(proj, capsys, extra_args=["--output", str(out_path)])
    assert code == 0
    on_disk = json.loads(out_path.read_text(encoding="utf-8"))
    assert on_disk == result


def test_verdicts_and_checks_match_schema_contract():
    schema = json.loads(_SCHEMA.read_text(encoding="utf-8"))
    assert list(la.VERDICTS) == schema["properties"]["verdict"]["enum"]
    assert list(la.CHECK_IDS) == (
        schema["properties"]["checks"]["items"]["properties"]["check_id"]["enum"])
    assert la.EXIT_CODES["authorized"] == 0
    assert la.EXIT_CODES["invalid_record"] == 2
    assert all(la.EXIT_CODES[v] == 3 for v in la.VERDICTS
               if v not in ("authorized", "invalid_record"))
