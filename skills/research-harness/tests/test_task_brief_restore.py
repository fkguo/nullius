"""Restore actual authored research state without promoting or modifying it."""
from __future__ import annotations

import pytest

from test_task_brief import BRIEF, BODY, alter_metadata, capture, expect, project, snapshot


def test_restore_retains_authored_bytes_and_original_source_locators(tmp_path):
    root = project(tmp_path)
    capture(root, "research_plan.md", "inputs/raw sample.bin")
    before = snapshot(root)
    report = expect(root, "restore", status="fresh", code=0)
    assert report["body"].encode("utf-8") == BODY
    assert [source["path"] for source in report["source_refs"]] == ["research_plan.md", "inputs/raw sample.bin"]
    assert all(len(source["sha256"]) == 64 for source in report["source_refs"])
    assert report["scope"] == "continuity_only"
    assert report["scientific_acceptance"] == "not_assessed"
    assert report["changes"] == []
    assert snapshot(root) == before


@pytest.mark.parametrize("change", ["source", "body", "missing"])
def test_stale_restore_keeps_the_work_visible_without_claiming_current_evidence(tmp_path, change):
    root = project(tmp_path)
    capture(root)
    if change == "source":
        (root / "research_plan.md").write_text("Changed assumptions\n")
    elif change == "body":
        brief = root / BRIEF
        brief.write_bytes(brief.read_bytes() + b"\nNew unverified direction\n")
    else:
        (root / "research_plan.md").unlink()
    before = snapshot(root)
    report = expect(root, "restore", status="stale", code=1)
    assert BODY.decode("utf-8") in report["body"]
    assert report["changes"]
    assert report["scientific_acceptance"] == "not_assessed"
    assert snapshot(root) == before


def test_restore_rejects_invalid_metadata_without_exposing_a_verified_looking_body(tmp_path):
    root = project(tmp_path)
    capture(root)
    alter_metadata(root / BRIEF, lambda metadata: {**metadata, "sources": []})
    before = snapshot(root)
    report = expect(root, "restore", status="invalid", code=2)
    assert "body" not in report
    assert snapshot(root) == before


def test_restore_works_after_relocation_and_does_not_read_unselected_sources(tmp_path):
    root = project(tmp_path)
    capture(root)
    (root / "inputs/raw sample.bin").unlink()
    relocated = tmp_path / "continued research"
    root.rename(relocated)
    report = expect(relocated, "restore", status="fresh", code=0)
    assert report["body"].encode() == BODY
    assert report["source_refs"][0]["path"] == "research_plan.md"
