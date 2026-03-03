#!/usr/bin/env python3
"""Tests for Information Membrane V1 — covers all 7 PASS + 7 BLOCK types.

At least 14 test cases (one per content type) plus additional edge cases
for sentence splitting, mixed content, and audit logging.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts" / "lib"))

from information_membrane import (
    MEMBRANE_VERSION,
    build_audit_record,
    detect_block_signals,
    detect_pass_signals,
    filter_message,
    split_into_segments,
    write_audit_log,
)


# ===========================================================================
# BLOCK type detection tests (7 types)
# ===========================================================================

class TestBlockDetection:
    """Each test covers one of the 7 BLOCK content types."""

    def test_block_num_result_equals(self):
        """NUM_RESULT: '= 3.14' pattern."""
        signals = detect_block_signals("The cross-section = 42.7 pb")
        assert any(s.signal_type == "NUM_RESULT" for s in signals)

    def test_block_num_result_approx(self):
        """NUM_RESULT: '≈' pattern."""
        signals = detect_block_signals("The mass ≈ 125.3 GeV")
        assert any(s.signal_type == "NUM_RESULT" for s in signals)

    def test_block_num_result_i_get(self):
        """NUM_RESULT: 'I get/obtain/find' pattern."""
        signals = detect_block_signals("I obtain a branching ratio of 0.034")
        assert any(s.signal_type == "NUM_RESULT" for s in signals)

    def test_block_sym_result_therefore(self):
        """SYM_RESULT: 'therefore $X$ =' pattern."""
        signals = detect_block_signals("therefore $\\Gamma$ = \\alpha^2 m / 4")
        assert any(s.signal_type == "SYM_RESULT" for s in signals)

    def test_block_sym_result_final(self):
        """SYM_RESULT: 'final result' pattern."""
        signals = detect_block_signals("The final result for the amplitude is given by")
        assert any(s.signal_type == "SYM_RESULT" for s in signals)

    def test_block_deriv_chain_steps(self):
        """DERIV_CHAIN: 'Step N: ... →' pattern."""
        signals = detect_block_signals("Step 1: expand → Step 2: integrate → result")
        assert any(s.signal_type == "DERIV_CHAIN" for s in signals)

    def test_block_deriv_chain_substituting(self):
        """DERIV_CHAIN: 'substituting ... we get' pattern."""
        signals = detect_block_signals("Substituting the propagator into the loop integral, we obtain")
        assert any(s.signal_type == "DERIV_CHAIN" for s in signals)

    def test_block_verdict_i_agree(self):
        """VERDICT: 'I agree' pattern."""
        signals = detect_block_signals("I agree with the conclusion drawn above")
        assert any(s.signal_type == "VERDICT" for s in signals)

    def test_block_verdict_correct(self):
        """VERDICT: 'correct' keyword."""
        signals = detect_block_signals("This derivation is correct in the limit")
        assert any(s.signal_type == "VERDICT" for s in signals)

    def test_block_verdict_confirmed(self):
        """VERDICT: 'CONFIRMED' marker."""
        signals = detect_block_signals("Step verdict: CONFIRMED")
        assert any(s.signal_type == "VERDICT" for s in signals)

    def test_block_code_output(self):
        """CODE_OUTPUT: code execution output."""
        signals = detect_block_signals("```output\n42.7\n```")
        assert any(s.signal_type == "CODE_OUTPUT" for s in signals)

    def test_block_code_output_running(self):
        """CODE_OUTPUT: 'running the code gives' pattern."""
        signals = detect_block_signals("Running the code gives a cross-section of 42 pb")
        assert any(s.signal_type == "CODE_OUTPUT" for s in signals)

    def test_block_agreement(self):
        """AGREEMENT: 'I agree with your/Member' pattern."""
        signals = detect_block_signals("I agree with Member B's numerical analysis")
        assert any(s.signal_type == "AGREEMENT" for s in signals)

    def test_block_agreement_same_result(self):
        """AGREEMENT: 'same result' pattern."""
        signals = detect_block_signals("We get the same result for the integral")
        assert any(s.signal_type == "AGREEMENT" for s in signals)

    def test_block_comparison_results_differ(self):
        """COMPARISON: 'our results differ' pattern."""
        signals = detect_block_signals("Our results differ by approximately 2%")
        assert any(s.signal_type == "COMPARISON" for s in signals)

    def test_block_comparison_compared_to(self):
        """COMPARISON: 'compared to your' pattern."""
        signals = detect_block_signals("Compared to your calculation, the phase space factor is larger")
        assert any(s.signal_type == "COMPARISON" for s in signals)


# ===========================================================================
# PASS type detection tests (7 types)
# ===========================================================================

class TestPassDetection:
    """Each test covers one of the 7 PASS content types."""

    def test_pass_method_suggest(self):
        """METHOD: 'suggest using method' pattern."""
        signals = detect_pass_signals("I suggest using adaptive Monte Carlo integration")
        assert any(s.signal_type == "METHOD" for s in signals)

    def test_pass_method_specific(self):
        """METHOD: specific method name."""
        signals = detect_pass_signals("Gauss-Kronrod quadrature is more suitable here")
        assert any(s.signal_type == "METHOD" for s in signals)

    def test_pass_reference_cite(self):
        """REFERENCE: '[Author 2023]' pattern."""
        signals = detect_pass_signals("See [Smith 2023] for the detailed treatment")
        assert any(s.signal_type == "REFERENCE" for s in signals)

    def test_pass_reference_arxiv(self):
        """REFERENCE: arXiv ID."""
        signals = detect_pass_signals("The technique from arXiv:2301.12345 is relevant")
        assert any(s.signal_type == "REFERENCE" for s in signals)

    def test_pass_reference_see_eq(self):
        """REFERENCE: 'see Eq.' pattern."""
        signals = detect_pass_signals("Refer to Eq.(3.14) in the paper")
        assert any(s.signal_type == "REFERENCE" for s in signals)

    def test_pass_convention(self):
        """CONVENTION: 'I use ... scheme' pattern."""
        signals = detect_pass_signals("I use the MS-bar renormalization scheme")
        assert any(s.signal_type == "CONVENTION" for s in signals)

    def test_pass_pitfall_watch_out(self):
        """PITFALL: 'watch out' + divergence."""
        signals = detect_pass_signals("Watch out for the infrared divergence at q=0")
        assert any(s.signal_type == "PITFALL" for s in signals)

    def test_pass_pitfall_branch_cut(self):
        """PITFALL: 'branch cut' keyword."""
        signals = detect_pass_signals("There is a branch cut along the negative real axis")
        assert any(s.signal_type == "PITFALL" for s in signals)

    def test_pass_criterion(self):
        """CRITERION: 'convergence' / 'precision' keywords."""
        signals = detect_pass_signals("The convergence criterion requires at least 6 significant digits")
        assert any(s.signal_type == "CRITERION" for s in signals)

    def test_pass_tool(self):
        """TOOL: specific tool name."""
        signals = detect_pass_signals("LoopTools provides a reliable implementation of PV functions")
        assert any(s.signal_type == "TOOL" for s in signals)

    def test_pass_assumption(self):
        """ASSUMPTION: 'I assume' pattern."""
        signals = detect_pass_signals("I assume massless quarks in the chiral limit")
        assert any(s.signal_type == "ASSUMPTION" for s in signals)

    def test_pass_assumption_neglecting(self):
        """ASSUMPTION: 'neglecting' keyword."""
        signals = detect_pass_signals("Neglecting higher-order QED corrections")
        assert any(s.signal_type == "ASSUMPTION" for s in signals)


# ===========================================================================
# filter_message() integration tests
# ===========================================================================

class TestFilterMessage:
    """Test the main filter_message() function."""

    def test_pure_pass_content(self):
        """Content with only PASS signals passes through unchanged."""
        text = "I suggest using Gauss-Kronrod quadrature for the loop integral."
        result = filter_message(text)
        assert result.blocked_count == 0
        assert "Gauss-Kronrod" in result.passed_text

    def test_pure_block_content(self):
        """Content with BLOCK signals is redacted."""
        text = "The final result is sigma = 42.7 pb."
        result = filter_message(text)
        assert result.blocked_count > 0
        assert "[REDACTED" in result.passed_text
        assert "42.7" not in result.passed_text

    def test_mixed_content_paragraphs(self):
        """Mixed content: PASS paragraphs preserved, BLOCK paragraphs redacted."""
        text = (
            "I suggest using dimensional regularization for this calculation.\n\n"
            "The cross-section I obtain is sigma = 42.7 pb."
        )
        result = filter_message(text)
        assert result.blocked_count == 1
        assert "dimensional regularization" in result.passed_text
        assert "42.7" not in result.passed_text

    def test_block_priority(self):
        """BLOCK takes priority over PASS in the same segment."""
        text = "I recommend using Gauss-Kronrod, and I get sigma = 3.14 pb."
        result = filter_message(text)
        assert result.blocked_count == 1
        # The segment had both METHOD (PASS) and NUM_RESULT (BLOCK) — BLOCK wins
        assert "[REDACTED" in result.passed_text

    def test_empty_text(self):
        """Empty text returns empty result."""
        result = filter_message("")
        assert result.blocked_count == 0
        assert result.total_segments == 0
        assert result.passed_text == ""

    def test_whitespace_only(self):
        """Whitespace-only text returns empty result."""
        result = filter_message("   \n\n  \n  ")
        assert result.total_segments == 0

    def test_neutral_content_passes(self):
        """Content with no BLOCK or PASS signals passes through."""
        text = "The Lagrangian density includes both gauge and matter fields."
        result = filter_message(text)
        assert result.blocked_count == 0
        assert "Lagrangian" in result.passed_text

    def test_audit_entries_match_segments(self):
        """Audit entries count matches segment count."""
        text = "First paragraph about methods.\n\nSecond paragraph with sigma = 3.14."
        result = filter_message(text)
        assert result.total_segments == 2
        assert len(result.audit_entries) == 2
        assert result.audit_entries[0].decision == "PASS"
        assert result.audit_entries[1].decision == "BLOCK"

    def test_redacted_marker_contains_type(self):
        """REDACTED marker includes the BLOCK type."""
        text = "I agree with your analysis completely."
        result = filter_message(text)
        assert result.blocked_count == 1
        assert "VERDICT" in result.passed_text or "AGREEMENT" in result.passed_text


# ===========================================================================
# Segment splitting tests
# ===========================================================================

class TestSegmentSplitting:
    """Test split_into_segments()."""

    def test_paragraphs_split(self):
        segments = split_into_segments("First paragraph.\n\nSecond paragraph.")
        assert len(segments) == 2

    def test_single_paragraph(self):
        segments = split_into_segments("Just one paragraph here.")
        assert len(segments) == 1

    def test_empty_lines_stripped(self):
        segments = split_into_segments("\n\n\nContent here.\n\n\n")
        assert len(segments) == 1
        assert segments[0] == "Content here."

    def test_bullet_items(self):
        text = "Introduction paragraph.\n\n- Item one\n- Item two\n- Item three"
        segments = split_into_segments(text)
        assert len(segments) >= 2  # at least intro + bullets


# ===========================================================================
# Audit logging tests
# ===========================================================================

class TestAuditLogging:
    """Test audit record building and writing."""

    def test_build_audit_record(self):
        text = "I obtain sigma = 42.7 pb."
        fr = filter_message(text)
        rec = build_audit_record(
            filter_result=fr,
            input_text=text,
            phase="phase_0",
            source_member="A",
            target_member="landscape",
        )
        assert rec.membrane_version == MEMBRANE_VERSION
        assert rec.input_hash.startswith("sha256:")
        assert rec.segments_blocked == fr.blocked_count
        assert rec.segments_total == fr.total_segments
        assert rec.phase == "phase_0"

    def test_write_audit_log(self, tmp_path):
        text = "The final result is 3.14."
        fr = filter_message(text)
        rec = build_audit_record(
            filter_result=fr,
            input_text=text,
            phase="phase_2",
            source_member="B",
            target_member="A",
        )
        filepath = write_audit_log(rec, tmp_path / "membrane_audit")
        assert filepath.exists()
        lines = filepath.read_text().strip().split("\n")
        assert len(lines) == 1
        data = json.loads(lines[0])
        assert data["membrane_version"] == MEMBRANE_VERSION
        assert data["phase"] == "phase_2"
        assert data["segments_blocked"] >= 1
        assert data["input_hash"].startswith("sha256:")

    def test_audit_log_append(self, tmp_path):
        """Multiple writes append to the same JSONL file."""
        audit_dir = tmp_path / "membrane_audit"
        for i in range(3):
            text = f"Result {i}: value = {i}.0"
            fr = filter_message(text)
            rec = build_audit_record(
                filter_result=fr, input_text=text,
                phase="phase_0", source_member="A", target_member="landscape",
            )
            write_audit_log(rec, audit_dir)

        filepath = audit_dir / "phase_0_A_landscape.jsonl"
        lines = filepath.read_text().strip().split("\n")
        assert len(lines) == 3


# ===========================================================================
# Regression: known edge cases
# ===========================================================================

class TestEdgeCases:
    """Regression tests for tricky patterns."""

    def test_equation_number_not_blocked(self):
        """'Eq.(3.12)' is a REFERENCE, not a NUM_RESULT."""
        text = "See Eq.(3.12) in the referenced paper."
        result = filter_message(text)
        # Should not be blocked — this is a PASS (REFERENCE)
        assert result.blocked_count == 0

    def test_inline_math_assignment_blocked(self):
        """'$\\sigma = 42$ pb' is a NUM_RESULT."""
        text = "We find $\\sigma = 42$ pb for the total cross-section."
        result = filter_message(text)
        assert result.blocked_count > 0

    def test_method_suggestion_not_blocked(self):
        """Pure method suggestion passes through."""
        text = "Consider using the Vegas algorithm for multi-dimensional integration."
        result = filter_message(text)
        assert result.blocked_count == 0

    def test_convention_statement_not_blocked(self):
        """Convention statement passes through."""
        text = "I use dimensional regularization with the on-shell renormalization scheme."
        result = filter_message(text)
        assert result.blocked_count == 0
