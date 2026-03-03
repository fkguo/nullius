#!/usr/bin/env python3
"""Tests for compile_method_landscape.py (Phase 0)."""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts" / "bin"))

from compile_method_landscape import (
    _compile_section,
    _extract_section,
    compile_landscape,
)


# ---------------------------------------------------------------------------
# Section extraction
# ---------------------------------------------------------------------------

class TestExtractSection:
    def test_extract_existing_section(self):
        text = "## Suggested Method Path\nUse Gauss-Kronrod.\n\n## Convention Choices\nMS-bar."
        result = _extract_section(text, "Suggested Method Path")
        assert "Gauss-Kronrod" in result

    def test_extract_missing_section(self):
        text = "## Other Section\nSome content."
        result = _extract_section(text, "Suggested Method Path")
        assert result == ""

    def test_extract_section_stops_at_next(self):
        text = "## Suggested Method Path\nMethod A.\n\n## Expected Difficulties\nHard integral."
        result = _extract_section(text, "Suggested Method Path")
        assert "Method A" in result
        assert "Hard integral" not in result


# ---------------------------------------------------------------------------
# Section compilation
# ---------------------------------------------------------------------------

class TestCompileSection:
    def test_both_members(self):
        result = _compile_section("Methods", "approach A", "approach B")
        assert "Member A" in result
        assert "Member B" in result

    def test_one_member_only(self):
        result = _compile_section("Methods", "approach A", "")
        assert "Member A" in result
        assert "Member B" not in result

    def test_no_members(self):
        result = _compile_section("Methods", "", "")
        assert "No input" in result


# ---------------------------------------------------------------------------
# Full landscape compilation
# ---------------------------------------------------------------------------

class TestCompileLandscape:
    def test_basic_compilation(self):
        member_a = (
            "## Suggested Method Path\n"
            "Use adaptive integration with Gauss-Kronrod.\n\n"
            "## Convention Choices\n"
            "I use the MS-bar scheme.\n"
        )
        member_b = (
            "## Suggested Method Path\n"
            "Consider Monte Carlo methods.\n\n"
            "## Convention Choices\n"
            "I use on-shell renormalization.\n"
        )
        landscape, fr_a, fr_b = compile_landscape(member_a, member_b)
        assert "Gauss-Kronrod" in landscape
        assert "Monte Carlo" in landscape
        assert "MS-bar" in landscape
        assert "on-shell" in landscape
        assert fr_a.blocked_count == 0
        assert fr_b.blocked_count == 0

    def test_blocks_numerical_results(self):
        """If a member sneaks in numerical results, they get filtered."""
        member_a = (
            "## Suggested Method Path\n"
            "Use adaptive integration.\n\n"
            "## Convention Choices\n"
            "The cross-section I obtain is sigma = 42.7 pb.\n"
        )
        member_b = "## Suggested Method Path\nMonte Carlo.\n"
        landscape, fr_a, fr_b = compile_landscape(member_a, member_b)
        assert "42.7" not in landscape
        assert fr_a.blocked_count > 0
        assert "[REDACTED" in landscape or fr_a.blocked_count > 0

    def test_landscape_header(self):
        landscape, _, _ = compile_landscape("## Suggested Method Path\nFoo", "## Suggested Method Path\nBar")
        assert "Method Landscape" in landscape
        assert "independently" in landscape.lower()

    def test_audit_dir(self, tmp_path):
        audit_dir = tmp_path / "membrane_audit"
        member_a = "## Suggested Method Path\nAdaptive integration."
        member_b = "## Suggested Method Path\nMonte Carlo."
        compile_landscape(member_a, member_b, audit_dir=audit_dir)
        assert audit_dir.exists()
        audit_files = list(audit_dir.glob("*.jsonl"))
        assert len(audit_files) >= 1

    def test_empty_inputs(self):
        landscape, fr_a, fr_b = compile_landscape("", "")
        assert "Method Landscape" in landscape
        assert fr_a.blocked_count == 0
        assert fr_b.blocked_count == 0
