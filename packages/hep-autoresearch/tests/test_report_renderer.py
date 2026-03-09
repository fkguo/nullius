"""Tests for report_renderer (NEW-04)."""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from hep_autoresearch.toolkit.report_renderer import (
    RunResult,
    collect_run_result,
    render_md,
    render_tex,
)


@pytest.fixture()
def sample_result() -> RunResult:
    return RunResult(
        run_id="run-abc",
        workflow_id="ingest",
        headline_numbers={"papers_found": 42, "accuracy": 0.95},
        artifacts=[
            {"path": "data.csv", "uri": "rep://run-abc/data.csv", "sha256": "a" * 64},
        ],
        summary="Ingested 42 papers with 95% accuracy.",
    )


def test_render_md_contains_run_info(sample_result: RunResult) -> None:
    text = render_md([sample_result])
    assert "run-abc" in text
    assert "ingest" in text
    assert "42 papers" in text


def test_render_md_has_audit_pointers(sample_result: RunResult) -> None:
    text = render_md([sample_result])
    assert "rep://run-abc/data.csv" in text
    assert "aaaaaaaaaaaaaaaa" in text  # sha256 prefix


def test_render_tex_compilable(sample_result: RunResult) -> None:
    text = render_tex([sample_result])
    assert r"\documentclass" in text
    assert r"\begin{document}" in text
    assert r"\end{document}" in text
    assert "run" in text


def test_render_md_headline_numbers(sample_result: RunResult) -> None:
    text = render_md([sample_result])
    assert "papers_found" in text
    assert "42" in text
    assert "accuracy" in text


def test_collect_run_result_from_disk(tmp_path: Path) -> None:
    run_id = "test-collect"
    run_dir = tmp_path / "artifacts" / "runs" / run_id
    run_dir.mkdir(parents=True)

    analysis = {
        "summary": "Test summary",
        "workflow_id": "ingest",
        "results": {"metric_a": 1.5},
    }
    (run_dir / "analysis.json").write_text(
        json.dumps(analysis), encoding="utf-8"
    )
    (run_dir / "output.csv").write_text(
        "a,b\n1,2\n", encoding="utf-8"
    )

    result = collect_run_result(tmp_path, run_id)
    assert result.run_id == run_id
    assert result.workflow_id == "ingest"
    assert result.summary == "Test summary"
    assert result.headline_numbers["metric_a"] == 1.5
    assert len(result.artifacts) == 2
    assert all("sha256" in a for a in result.artifacts)


def test_render_md_full_sha256(sample_result: RunResult) -> None:
    """SHA256 audit pointer must be the full 64-char hex digest, not truncated (R4 fix)."""
    text = render_md([sample_result])
    full_hash = "a" * 64
    assert full_hash in text


def test_render_tex_full_sha256(sample_result: RunResult) -> None:
    """LaTeX SHA256 audit pointer must also be the full 64-char hex digest (R4 fix)."""
    text = render_tex([sample_result])
    full_hash = "a" * 64
    assert full_hash in text


def test_collect_run_result_prefers_run_level_analysis(tmp_path: Path) -> None:
    """collect_run_result must prefer run-level analysis.json over nested ones (R5 fix)."""
    run_id = "test-priority"
    run_dir = tmp_path / "artifacts" / "runs" / run_id
    run_dir.mkdir(parents=True)

    # Nested analysis.json (in a subdirectory that sorts before "analysis.json")
    nested = run_dir / "a_workflow"
    nested.mkdir()
    (nested / "analysis.json").write_text(
        json.dumps({"summary": "WRONG nested", "workflow_id": "revision", "results": {}}),
        encoding="utf-8",
    )

    # Run-level analysis.json — this should win
    (run_dir / "analysis.json").write_text(
        json.dumps({"summary": "CORRECT top-level", "workflow_id": "reproduce", "results": {"x": 1}}),
        encoding="utf-8",
    )

    result = collect_run_result(tmp_path, run_id)
    assert result.summary == "CORRECT top-level"
    assert result.workflow_id == "reproduce"
