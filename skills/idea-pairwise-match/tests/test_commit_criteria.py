"""Tests for commit_criteria.py: canonicalization, hash stability, CLI."""

import json
import subprocess
import sys
import unicodedata
from pathlib import Path

import pytest

import commit_criteria

SCRIPT = Path(commit_criteria.__file__)


def test_hash_is_order_invariant():
    forward = commit_criteria.commitment_hash(["tension resolution", "verification cost"])
    backward = commit_criteria.commitment_hash(["verification cost", "tension resolution"])
    assert forward == backward


def test_hash_is_whitespace_and_nfc_invariant():
    plain = commit_criteria.commitment_hash(["mechanism insight"])
    spaced = commit_criteria.commitment_hash(["  mechanism   insight  "])
    assert plain == spaced
    composed = "critérion"  # e with acute, precomposed
    decomposed = unicodedata.normalize("NFD", composed)
    assert composed != decomposed
    assert (
        commit_criteria.commitment_hash([composed])
        == commit_criteria.commitment_hash([decomposed])
    )


def test_hash_differs_for_different_criteria():
    one = commit_criteria.commitment_hash(["tension resolution"])
    other = commit_criteria.commitment_hash(["verification cost"])
    assert one != other


def test_hash_covers_only_the_criteria_list():
    early = commit_criteria.build_commitment(
        ["mechanism insight"], committed_at="2026-01-01T00:00:00+00:00"
    )
    late = commit_criteria.build_commitment(
        ["mechanism insight"], committed_at="2026-06-01T12:34:56+00:00"
    )
    assert early["commitment_hash"] == late["commitment_hash"]


def test_rejects_empty_and_duplicate_criteria():
    with pytest.raises(commit_criteria.CriteriaError):
        commit_criteria.canonicalize_criteria([])
    with pytest.raises(commit_criteria.CriteriaError):
        commit_criteria.canonicalize_criteria(["ok", "   "])
    with pytest.raises(commit_criteria.CriteriaError):
        commit_criteria.canonicalize_criteria(["same", "same "])
    with pytest.raises(commit_criteria.CriteriaError):
        commit_criteria.canonicalize_criteria(["ok", 3])


def test_stored_criteria_are_canonical_sorted():
    commitment = commit_criteria.build_commitment(["b criterion", "a criterion"])
    assert commitment["criteria"] == ["a criterion", "b criterion"]
    assert not commit_criteria.validate_commitment(commitment)


def test_validate_commitment_catches_tampered_criteria():
    commitment = commit_criteria.build_commitment(["a criterion", "b criterion"])
    tampered = dict(commitment)
    tampered["criteria"] = ["a criterion", "c criterion"]
    problems = commit_criteria.validate_commitment(tampered)
    assert any("does not match" in p for p in problems)


def test_validate_commitment_rejects_unknown_keys_and_bad_hash_form():
    commitment = commit_criteria.build_commitment(["a criterion"])
    extra = dict(commitment)
    extra["surprise"] = 1
    assert any("unknown keys" in p for p in commit_criteria.validate_commitment(extra))
    bad_hash = dict(commitment)
    bad_hash["commitment_hash"] = "sha256:zzz"
    assert any(
        "sha256:<64 hex>" in p for p in commit_criteria.validate_commitment(bad_hash)
    )


def test_cli_writes_commitment_and_refuses_overwrite(tmp_path):
    out = tmp_path / "commitment.json"
    first = subprocess.run(
        [sys.executable, str(SCRIPT), "--out", str(out)],
        capture_output=True,
        text=True,
    )
    assert first.returncode == 0, first.stderr
    data = json.loads(out.read_text(encoding="utf-8"))
    assert data["criteria"] == sorted(commit_criteria.DEFAULT_CRITERIA)
    assert not commit_criteria.validate_commitment(data)

    second = subprocess.run(
        [sys.executable, str(SCRIPT), "--out", str(out)],
        capture_output=True,
        text=True,
    )
    assert second.returncode == 2
    assert "never overwritten" in second.stderr
    assert json.loads(out.read_text(encoding="utf-8")) == data


def test_cli_accepts_custom_criteria(tmp_path):
    out = tmp_path / "commitment.json"
    result = subprocess.run(
        [
            sys.executable,
            str(SCRIPT),
            "--out",
            str(out),
            "--criteria",
            "novel mechanism",
            "cheap verification",
        ],
        capture_output=True,
        text=True,
    )
    assert result.returncode == 0, result.stderr
    data = json.loads(out.read_text(encoding="utf-8"))
    assert data["criteria"] == ["cheap verification", "novel mechanism"]
