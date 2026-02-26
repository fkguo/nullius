"""Tests for approval_packet trio renderer (NEW-02)."""
from __future__ import annotations

import argparse
import json
from pathlib import Path

import pytest

from hep_autoresearch.toolkit.approval_packet import (
    ApprovalPacketData,
    SHORT_LINE_LIMIT,
    render_full,
    render_json,
    render_short,
    write_trio,
)


@pytest.fixture()
def sample_data() -> ApprovalPacketData:
    return ApprovalPacketData(
        approval_id="A1-0001",
        gate_id="A1",
        run_id="test-run-1",
        workflow_id="W1_ingest",
        purpose="Test the ingest pipeline end-to-end.",
        plan=["Download papers", "Parse metadata", "Index results"],
        risks=["Network timeout", "Malformed PDF"],
        budgets={"max_network_calls": 100, "max_runtime_minutes": 30},
        outputs=["artifacts/runs/test-run-1/ingest/"],
        rollback="Delete ingested artifacts and reset state.",
        commands=["hepar run --run-id test-run-1 --workflow-id W1_ingest"],
        checklist=["Verify network access", "Check disk space"],
        requested_at="2026-02-26T12:00:00Z",
    )


def test_render_short_within_line_limit(sample_data: ApprovalPacketData) -> None:
    text = render_short(sample_data)
    lines = text.split("\n")
    assert len(lines) <= SHORT_LINE_LIMIT, f"render_short produced {len(lines)} lines, limit is {SHORT_LINE_LIMIT}"
    assert "A1-0001" in text
    assert "Test the ingest pipeline" in text
    assert "max_network_calls" in text


def test_render_short_overflow_still_within_limit(sample_data: ApprovalPacketData) -> None:
    """When content exceeds 60 lines, truncation + overflow note must still fit in 60."""
    sample_data.plan = [f"Step {i}" for i in range(50)]  # force overflow
    text = render_short(sample_data)
    lines = text.split("\n")
    assert len(lines) <= SHORT_LINE_LIMIT, f"overflow case: {len(lines)} lines > {SHORT_LINE_LIMIT}"
    assert "packet.md" in text  # overflow pointer present


def test_render_full_contains_all_sections(sample_data: ApprovalPacketData) -> None:
    text = render_full(sample_data)
    assert "## Purpose" in text
    assert "## Plan (what will be done)" in text
    assert "## Budgets" in text
    assert "## Risks / failure modes" in text
    assert "## Outputs (paths)" in text
    assert "## Rollback" in text
    assert "A1-0001" in text
    assert "test-run-1" in text


def test_render_full_with_gate_trace(sample_data: ApprovalPacketData) -> None:
    sample_data.gate_resolution_trace = [
        {"gate_id": "A1", "triggered_by": "policy", "reason": "budget exceeded"}
    ]
    text = render_full(sample_data)
    assert "## Gate resolution trace" in text
    assert "budget exceeded" in text


def test_render_json_schema_fields(sample_data: ApprovalPacketData) -> None:
    obj = render_json(sample_data)
    assert obj["schema_version"] == 1
    assert obj["approval_id"] == "A1-0001"
    assert obj["gate_id"] == "A1"
    assert obj["run_id"] == "test-run-1"
    assert isinstance(obj["plan"], list)
    assert isinstance(obj["risks"], list)
    assert isinstance(obj["budgets"], dict)
    assert isinstance(obj["outputs"], list)
    assert isinstance(obj["commands"], list)
    assert isinstance(obj["checklist"], list)
    assert "rollback" in obj
    assert "requested_at" in obj


def test_render_json_valid_json(sample_data: ApprovalPacketData) -> None:
    obj = render_json(sample_data)
    # Must be JSON-serializable
    text = json.dumps(obj)
    parsed = json.loads(text)
    assert parsed["approval_id"] == "A1-0001"


def test_write_trio_creates_three_files(
    sample_data: ApprovalPacketData, tmp_path: Path
) -> None:
    approval_dir = tmp_path / "approvals" / "A1-0001"
    write_trio(sample_data, approval_dir)

    assert (approval_dir / "packet_short.md").exists()
    assert (approval_dir / "packet.md").exists()
    assert (approval_dir / "approval_packet_v1.json").exists()

    # JSON must be parseable
    obj = json.loads(
        (approval_dir / "approval_packet_v1.json").read_text("utf-8")
    )
    assert obj["schema_version"] == 1
    assert obj["approval_id"] == "A1-0001"


def test_approvals_show_json_empty_array_no_dir(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    """--format json must output '[]' when no approvals directory exists (R4 fix)."""
    from hep_autoresearch.orchestrator_cli import cmd_approvals_show

    args = argparse.Namespace(
        project_root=str(tmp_path), run_id="nonexistent", gate=None, format="json"
    )
    ret = cmd_approvals_show(args)
    assert ret == 0
    out = capsys.readouterr().out.strip()
    assert json.loads(out) == []


def test_approvals_show_json_empty_array_no_match(
    sample_data: ApprovalPacketData, tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    """--format json must output '[]' when gate filter matches nothing (R4 fix)."""
    from hep_autoresearch.orchestrator_cli import cmd_approvals_show

    # Create approvals dir with one entry
    approval_dir = tmp_path / "artifacts" / "runs" / "r1" / "approvals" / "A1-0001"
    write_trio(sample_data, approval_dir)

    args = argparse.Namespace(
        project_root=str(tmp_path), run_id="r1", gate="NONEXISTENT", format="json"
    )
    ret = cmd_approvals_show(args)
    assert ret == 0
    out = capsys.readouterr().out.strip()
    assert json.loads(out) == []


def test_approvals_show_json_malformed_packet(
    sample_data: ApprovalPacketData, tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    """--format json must degrade gracefully when approval_packet_v1.json is malformed (R4 fix)."""
    from hep_autoresearch.orchestrator_cli import cmd_approvals_show

    # Create approvals dir with a valid trio, then corrupt the JSON file
    approval_dir = tmp_path / "artifacts" / "runs" / "r1" / "approvals" / "A1-0001"
    write_trio(sample_data, approval_dir)
    (approval_dir / "approval_packet_v1.json").write_text("{bad json", encoding="utf-8")

    args = argparse.Namespace(
        project_root=str(tmp_path), run_id="r1", gate=None, format="json"
    )
    ret = cmd_approvals_show(args)
    assert ret == 0
    out = capsys.readouterr().out.strip()
    result = json.loads(out)
    assert isinstance(result, list)
    assert len(result) == 1
    assert "error" in result[0]
    assert "malformed" in result[0]["error"].lower()


def test_approvals_show_json_non_utf8_packet(
    sample_data: ApprovalPacketData, tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    """--format json must not crash on non-UTF8 packet files (R5 fix)."""
    from hep_autoresearch.orchestrator_cli import cmd_approvals_show

    approval_dir = tmp_path / "artifacts" / "runs" / "r1" / "approvals" / "A1-0001"
    write_trio(sample_data, approval_dir)
    # Write raw bytes that are not valid UTF-8
    (approval_dir / "approval_packet_v1.json").write_bytes(b"\xff\xfe{bad}")

    args = argparse.Namespace(
        project_root=str(tmp_path), run_id="r1", gate=None, format="json"
    )
    ret = cmd_approvals_show(args)
    assert ret == 0
    out = capsys.readouterr().out.strip()
    result = json.loads(out)
    assert isinstance(result, list)
    assert len(result) == 1
    assert "error" in result[0]
