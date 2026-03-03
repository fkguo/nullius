#!/usr/bin/env python3
"""Tests for compile_method_landscape.py (Phase 0)."""
from __future__ import annotations

import sys
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts" / "bin"))
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts" / "lib"))

from compile_method_landscape import (
    _compile_section,
    _extract_section,
    compile_landscape,
)
from information_membrane import MembraneConfig


def _make_pass_all_mock():
    """Mock _call_llm that PASSes all segments."""
    def _mock(messages, *, config, use_structured=True):
        user_msg = messages[-1]["content"]
        count = user_msg.count('"segment_index"')
        return {"classifications": [
            {"segment_index": i, "decision": "PASS",
             "block_type": None, "pass_type": "METHOD", "reason": "ok"}
            for i in range(1, count + 1)
        ]}
    return _mock


def _make_block_all_mock():
    """Mock _call_llm that BLOCKs all segments."""
    def _mock(messages, *, config, use_structured=True):
        user_msg = messages[-1]["content"]
        count = user_msg.count('"segment_index"')
        return {"classifications": [
            {"segment_index": i, "decision": "BLOCK",
             "block_type": "NUM_RESULT", "pass_type": None, "reason": "blocked"}
            for i in range(1, count + 1)
        ]}
    return _mock


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
    @patch("information_membrane._call_llm")
    def test_basic_compilation(self, mock_llm):
        mock_llm.side_effect = _make_pass_all_mock()
        config = MembraneConfig(api_key="test-key")
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
        landscape, fr_a, fr_b = compile_landscape(member_a, member_b, config=config)
        assert "Gauss-Kronrod" in landscape
        assert "Monte Carlo" in landscape
        assert "MS-bar" in landscape
        assert "on-shell" in landscape
        assert fr_a.blocked_count == 0
        assert fr_b.blocked_count == 0

    @patch("information_membrane._call_llm")
    def test_blocks_numerical_results(self, mock_llm):
        """If a member sneaks in numerical results, they get filtered."""
        mock_llm.side_effect = _make_block_all_mock()
        config = MembraneConfig(api_key="test-key")
        member_a = (
            "## Suggested Method Path\n"
            "Use adaptive integration.\n\n"
            "## Convention Choices\n"
            "The cross-section I obtain is sigma = 42.7 pb.\n"
        )
        member_b = "## Suggested Method Path\nMonte Carlo.\n"
        landscape, fr_a, fr_b = compile_landscape(member_a, member_b, config=config)
        assert "42.7" not in landscape
        assert fr_a.blocked_count > 0
        assert "[REDACTED" in landscape or fr_a.blocked_count > 0

    @patch("information_membrane._call_llm")
    def test_landscape_header(self, mock_llm):
        mock_llm.side_effect = _make_pass_all_mock()
        config = MembraneConfig(api_key="test-key")
        landscape, _, _ = compile_landscape(
            "## Suggested Method Path\nFoo",
            "## Suggested Method Path\nBar",
            config=config,
        )
        assert "Method Landscape" in landscape
        assert "independently" in landscape.lower()

    @patch("information_membrane._call_llm")
    def test_audit_dir(self, mock_llm, tmp_path):
        mock_llm.side_effect = _make_pass_all_mock()
        config = MembraneConfig(api_key="test-key")
        audit_dir = tmp_path / "membrane_audit"
        member_a = "## Suggested Method Path\nAdaptive integration."
        member_b = "## Suggested Method Path\nMonte Carlo."
        compile_landscape(member_a, member_b, audit_dir=audit_dir, config=config)
        assert audit_dir.exists()
        audit_files = list(audit_dir.glob("*.jsonl"))
        assert len(audit_files) >= 1

    def test_empty_inputs(self):
        """Empty inputs → no segments → no LLM call needed."""
        config = MembraneConfig(api_key="test-key")
        landscape, fr_a, fr_b = compile_landscape("", "", config=config)
        assert "Method Landscape" in landscape
        assert fr_a.blocked_count == 0
        assert fr_b.blocked_count == 0
