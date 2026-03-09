"""Tests for approval_packet trio renderer (NEW-02) + UX-07 gate context enrichment."""
from __future__ import annotations

import argparse
import json
from pathlib import Path

import pytest

from hep_autoresearch.toolkit.approval_packet import (
    ApprovalPacketData,
    GateContextSummary,
    KeyResult,
    SHORT_LINE_LIMIT,
    assemble_a0_context,
    assemble_a1_context,
    assemble_a2_context,
    assemble_a3_context,
    assemble_a4_context,
    assemble_a5_context,
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
        workflow_id="ingest",
        purpose="Test the ingest pipeline end-to-end.",
        plan=["Download papers", "Parse metadata", "Index results"],
        risks=["Network timeout", "Malformed PDF"],
        budgets={"max_network_calls": 100, "max_runtime_minutes": 30},
        outputs=["artifacts/runs/test-run-1/ingest/"],
        rollback="Delete ingested artifacts and reset state.",
        commands=["hepar run --run-id test-run-1 --workflow-id ingest"],
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


# ─────────────────────────────────────────────────────────────────────────────
# UX-07: Gate context assemblers
# ─────────────────────────────────────────────────────────────────────────────


def test_assemble_a0_context_basic() -> None:
    ctx = assemble_a0_context(
        thesis="Dark matter is a Dirac fermion.",
        hypotheses=["H1: coupling > 0.1", "H2: mass 1-10 GeV"],
        compute_difficulty="medium",
        literature_coverage="32 papers; gaps in 1-10 GeV range",
    )
    assert isinstance(ctx, GateContextSummary)
    assert ctx.gate_id == "A0"
    assert "Dark matter" in ctx.summary
    assert len(ctx.key_results) == 2  # two hypotheses
    assert ctx.key_results[0].label == "Hypothesis 1"


def test_assemble_a1_context_hit_count() -> None:
    ctx = assemble_a1_context(
        retrieval_strategy="INSPIRE: dark matter LHC",
        hit_count=45,
        coverage_summary="Good coverage for 2015–2024",
        missed_risk="Pre-LHC papers underrepresented",
    )
    assert ctx.gate_id == "A1"
    assert "45" in ctx.summary
    assert any(kr.label == "Retrieved papers" for kr in ctx.key_results)


def test_assemble_a2_context_diff_stats() -> None:
    ctx = assemble_a2_context(
        changed_files=["src/a.py", "src/b.py", "tests/test_a.py"],
        lines_added=120,
        lines_removed=30,
        test_coverage_status="pass (95%)",
    )
    assert ctx.gate_id == "A2"
    assert "3 file(s) changed" in ctx.summary
    assert "+120/-30 lines" in ctx.summary
    files_result = next(kr for kr in ctx.key_results if kr.label == "Files changed")
    assert files_result.value == "3"


def test_assemble_a3_context_parameters() -> None:
    ctx = assemble_a3_context(
        parameter_rationale="renormalization scale mu=mZ chosen to minimize logs",
        computation_budget="~2h on 4 cores",
        expected_precision="1% relative error",
        key_parameters=[("mu", "91.2"), ("alpha_s", "0.118")],
    )
    assert ctx.gate_id == "A3"
    assert len(ctx.key_results) == 2
    assert ctx.key_results[0].label == "mu"
    assert ctx.key_results[0].value == "91.2"


def test_assemble_a4_context_coverage() -> None:
    ctx = assemble_a4_context(
        modification_summary="Rewrote section 3, updated abstract",
        citation_changes="2 added, 1 removed",
        evidence_coverage_pct=87.5,
        integrity_flags=["citation [10] may be stale"],
    )
    assert ctx.gate_id == "A4"
    assert "87.5%" in ctx.summary or "88%" in ctx.summary
    assert len(ctx.integrity_flags) == 1
    cov_result = next(kr for kr in ctx.key_results if kr.label == "Evidence coverage")
    assert cov_result.unit == "%"


def test_assemble_a5_context_results_table() -> None:
    ctx = assemble_a5_context(
        core_results=[
            ("sigma_total", "1.23 ± 0.05", "pb"),
            ("K-factor", "1.42", ""),
        ],
        cross_validation_summary="Agrees with MadGraph5 at 1% level",
        recommendation="APPROVE",
    )
    assert ctx.gate_id == "A5"
    assert len(ctx.key_results) == 2
    assert ctx.key_results[0].unit == "pb"
    assert ctx.recommendation == "APPROVE"
    assert "2 key result(s)" in ctx.summary


def test_gate_context_in_render_short(sample_data: ApprovalPacketData) -> None:
    """Gate context section appears in packet_short when gate_context is set."""
    sample_data.gate_context = assemble_a1_context(
        retrieval_strategy="INSPIRE: top quark mass",
        hit_count=18,
        recommendation="APPROVE",
    )
    text = render_short(sample_data)
    assert "Gate Context" in text
    assert "18" in text
    assert "APPROVE" in text
    # Must still respect line limit
    assert len(text.split("\n")) <= SHORT_LINE_LIMIT


def test_gate_context_in_render_json(sample_data: ApprovalPacketData) -> None:
    """context_summary and key_results appear in JSON when gate_context is set."""
    sample_data.gate_context = assemble_a5_context(
        core_results=[("m_top", "172.5", "GeV")],
        cross_validation_summary="consistent",
        recommendation="APPROVE",
        integrity_flags=["preliminary result"],
    )
    obj = render_json(sample_data)
    assert "context_summary" in obj
    assert "key_results" in obj
    assert len(obj["key_results"]) == 1  # type: ignore[arg-type]
    assert obj["key_results"][0]["label"] == "m_top"  # type: ignore[index]
    assert obj["key_results"][0]["unit"] == "GeV"  # type: ignore[index]
    assert obj["integrity_flags"] == ["preliminary result"]
    assert obj["recommendation"] == "APPROVE"


def test_no_gate_context_no_section(sample_data: ApprovalPacketData) -> None:
    """When gate_context is None, no Gate Context section appears."""
    assert sample_data.gate_context is None
    text = render_short(sample_data)
    assert "Gate Context" not in text
    obj = render_json(sample_data)
    assert "context_summary" not in obj
    assert "key_results" not in obj


def test_gate_context_write_trio(
    sample_data: ApprovalPacketData, tmp_path: Path
) -> None:
    """write_trio writes v1 file (no gate_context) + v2 file (enriched) when gate_context is set."""
    sample_data.gate_context = assemble_a2_context(
        changed_files=["a.py"], lines_added=10, lines_removed=2,
    )
    approval_dir = tmp_path / "approvals" / "A1-ctx"
    paths = write_trio(sample_data, approval_dir)

    # v1 file must NOT contain gate_context fields (strict v1 schema compliance)
    v1_obj = json.loads((approval_dir / "approval_packet_v1.json").read_text("utf-8"))
    assert "key_results" not in v1_obj
    assert "context_summary" not in v1_obj
    assert v1_obj["schema_version"] == 1

    # v2 file must exist and contain enriched fields
    assert "packet_json_v2" in paths
    v2_obj = json.loads((approval_dir / "approval_packet_v2.json").read_text("utf-8"))
    assert "key_results" in v2_obj
    assert any(kr["label"] == "Files changed" for kr in v2_obj["key_results"])
    assert v2_obj["schema_version"] == 2

    # packet_short must still contain the gate context section
    short = (approval_dir / "packet_short.md").read_text("utf-8")
    assert "Gate Context" in short


def test_write_trio_no_v2_file_when_no_context(
    sample_data: ApprovalPacketData, tmp_path: Path
) -> None:
    """When gate_context is None, no approval_packet_v2.json is written."""
    assert sample_data.gate_context is None
    approval_dir = tmp_path / "approvals" / "A1-plain"
    paths = write_trio(sample_data, approval_dir)
    assert "packet_json_v2" not in paths
    assert not (approval_dir / "approval_packet_v2.json").exists()
