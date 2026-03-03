#!/usr/bin/env python3
"""Tests for extract_consultation_flags.py and filter_consultation_response.py (Phase 2)."""
from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts" / "bin"))

from extract_consultation_flags import (
    Flag,
    extract_flags,
    flags_to_questions,
    serialize_questions,
)

# Also make lib importable for filter_consultation_response
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts" / "lib"))

from filter_consultation_response import filter_response


# ===========================================================================
# FLAG extraction tests
# ===========================================================================

class TestExtractFlags:
    """Test FLAG marker parsing from reports."""

    def test_html_comment_flag(self):
        text = '<!-- FLAG: UNCERTAIN — branch cut handling for the loop integral -->'
        flags = extract_flags(text)
        assert len(flags) == 1
        assert flags[0].flag_type == "UNCERTAIN"
        assert "branch cut" in flags[0].context

    def test_inline_flag(self):
        text = "FLAG: METHOD_QUESTION — which integration method for 4-point function"
        flags = extract_flags(text)
        assert len(flags) == 1
        assert flags[0].flag_type == "METHOD_QUESTION"

    def test_multiple_flags(self):
        text = (
            "Some text.\n"
            "<!-- FLAG: UNCERTAIN — IR divergence treatment -->\n"
            "More text.\n"
            "<!-- FLAG: CONVENTION_MISMATCH — MS-bar vs on-shell scheme -->\n"
        )
        flags = extract_flags(text)
        assert len(flags) == 2
        types = {f.flag_type for f in flags}
        assert "UNCERTAIN" in types
        assert "CONVENTION_MISMATCH" in types

    def test_no_flags(self):
        text = "This report has no FLAG markers at all."
        flags = extract_flags(text)
        assert len(flags) == 0

    def test_flag_with_dash_separator(self):
        text = '<!-- FLAG: TOOL_QUESTION -- which library for PV reduction -->'
        flags = extract_flags(text)
        assert len(flags) == 1
        assert flags[0].flag_type == "TOOL_QUESTION"

    def test_flag_line_number(self):
        text = "Line 1\nLine 2\n<!-- FLAG: UNCERTAIN — something -->\nLine 4"
        flags = extract_flags(text)
        assert len(flags) == 1
        assert flags[0].source_line == 3


# ===========================================================================
# Question generation tests
# ===========================================================================

class TestFlagsToQuestions:
    """Test HOW question generation from flags."""

    def test_uncertain_flag(self):
        flags = [Flag(flag_type="UNCERTAIN", context="branch cut at z=0", source_line=10)]
        questions = flags_to_questions(flags)
        assert len(questions) == 1
        assert "How" in questions[0].question
        assert "branch cut" in questions[0].question

    def test_method_question_flag(self):
        flags = [Flag(flag_type="METHOD_QUESTION", context="integral over phase space", source_line=20)]
        questions = flags_to_questions(flags)
        assert len(questions) == 1
        assert "method" in questions[0].question.lower() or "algorithm" in questions[0].question.lower()

    def test_convention_mismatch_flag(self):
        flags = [Flag(flag_type="CONVENTION_MISMATCH", context="renormalization scheme", source_line=30)]
        questions = flags_to_questions(flags)
        assert len(questions) == 1
        assert "convention" in questions[0].question.lower()

    def test_unknown_flag_type_uses_default(self):
        flags = [Flag(flag_type="UNKNOWN_TYPE", context="something unusual", source_line=1)]
        questions = flags_to_questions(flags)
        assert len(questions) == 1
        assert "How" in questions[0].question

    def test_serialization(self):
        flags = [Flag(flag_type="UNCERTAIN", context="test", source_line=5)]
        questions = flags_to_questions(flags)
        data = serialize_questions("A", questions)
        assert data["member"] == "A"
        assert len(data["questions"]) == 1
        assert data["questions"][0]["flag_type"] == "UNCERTAIN"
        # Verify JSON-serializable
        json.dumps(data)


# ===========================================================================
# Response filtering tests
# ===========================================================================

class TestFilterResponse:
    """Test consultation response filtering through Information Membrane."""

    def test_clean_methodological_answer(self):
        text = "For this type of integral, I recommend Gauss-Kronrod quadrature."
        result = filter_response(text)
        assert "Gauss-Kronrod" in result
        assert "[REDACTED" not in result

    def test_blocks_numerical_result(self):
        text = "The integral gives 3.14159 after numerical evaluation."
        result = filter_response(text)
        assert "3.14159" not in result
        assert "REDACTED" in result
        assert "Information Membrane" in result

    def test_blocks_verdict(self):
        text = "I think your approach is correct and the derivation is valid."
        result = filter_response(text)
        assert "REDACTED" in result

    def test_mixed_response(self):
        text = (
            "I recommend using the Vegas algorithm for this.\n\n"
            "My result for the same integral is sigma = 42 pb."
        )
        result = filter_response(text)
        assert "Vegas" in result
        assert "42" not in result

    def test_audit_dir(self, tmp_path):
        audit_dir = tmp_path / "membrane_audit"
        text = "The final result is 3.14."
        filter_response(
            text,
            phase="phase_2",
            source_member="B",
            target_member="A",
            audit_dir=audit_dir,
        )
        assert audit_dir.exists()
        audit_files = list(audit_dir.glob("*.jsonl"))
        assert len(audit_files) == 1


# ===========================================================================
# CLI integration test (exit codes)
# ===========================================================================

class TestExtractFlagsCLI:
    """Test the CLI main() function."""

    def test_no_flags_returns_exit_2(self, tmp_path):
        from extract_consultation_flags import main as extract_main

        (tmp_path / "a.md").write_text("No flags here.")
        (tmp_path / "b.md").write_text("No flags here either.")
        out_dir = tmp_path / "output"
        exit_code = extract_main([
            "--member-a", str(tmp_path / "a.md"),
            "--member-b", str(tmp_path / "b.md"),
            "--output-dir", str(out_dir),
        ])
        assert exit_code == 2  # no flags = skip Phase 2

    def test_with_flags_returns_exit_0(self, tmp_path):
        from extract_consultation_flags import main as extract_main

        (tmp_path / "a.md").write_text("<!-- FLAG: UNCERTAIN — test uncertainty -->")
        (tmp_path / "b.md").write_text("No flags.")
        out_dir = tmp_path / "output"
        exit_code = extract_main([
            "--member-a", str(tmp_path / "a.md"),
            "--member-b", str(tmp_path / "b.md"),
            "--output-dir", str(out_dir),
        ])
        assert exit_code == 0
        assert (out_dir / "questions_a.json").exists()
