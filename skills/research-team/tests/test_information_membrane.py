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


# ===========================================================================
# Regression: R1 review-swarm bypass vectors (Codex-identified)
# ===========================================================================

class TestR1BypassRegressions:
    """Regression tests for bypass vectors found in review-swarm R1.

    These specific strings were identified by Codex as passing through the
    Membrane unblocked when they should be blocked.
    """

    def test_cross_section_is_42_pb(self):
        """'The cross section is 42 pb.' must be blocked (NUM_RESULT)."""
        text = "The cross section is 42 pb."
        result = filter_message(text)
        assert result.blocked_count > 0
        assert result.blocked_spans[0].block_type == "NUM_RESULT"

    def test_result_colon_42(self):
        """'Result: 42' must be blocked (NUM_RESULT)."""
        text = "Result: 42"
        result = filter_message(text)
        assert result.blocked_count > 0
        assert result.blocked_spans[0].block_type == "NUM_RESULT"

    def test_amplitude_latex_assignment(self):
        r"""'The amplitude is $A = g^2/(16\pi^2)$.' must be blocked (SYM_RESULT)."""
        text = r"The amplitude is $A = g^2/(16\pi^2)$."
        result = filter_message(text)
        assert result.blocked_count > 0
        assert result.blocked_spans[0].block_type == "SYM_RESULT"

    def test_step_chain_without_arrows(self):
        """'Step 1: expand, step 2: integrate, step 3: simplify.' must be blocked (DERIV_CHAIN)."""
        text = "Step 1: expand the amplitude, step 2: integrate over loop momenta."
        result = filter_message(text)
        assert result.blocked_count > 0
        assert result.blocked_spans[0].block_type == "DERIV_CHAIN"

    def test_multi_verb_derivation_flow(self):
        """'expand ... integrate ... simplify' derivation flow must be blocked."""
        text = "First expand the propagator, then integrate the loop momentum, then simplify using Feynman parameters."
        result = filter_message(text)
        assert result.blocked_count > 0
        assert result.blocked_spans[0].block_type == "DERIV_CHAIN"

    def test_sigma_equals_number(self):
        """'sigma = 0.35' must be blocked (NUM_RESULT)."""
        text = "sigma = 0.35 pb for the total cross section."
        result = filter_message(text)
        assert result.blocked_count > 0
        assert result.blocked_spans[0].block_type == "NUM_RESULT"

    def test_mass_equals_number(self):
        """'mass = 125.1' must be blocked (NUM_RESULT)."""
        text = "The Higgs mass = 125.1 GeV."
        result = filter_message(text)
        assert result.blocked_count > 0

    def test_latex_math_variable_assignment(self):
        r"""'$\Gamma = 4.07$ MeV' must be blocked (SYM_RESULT)."""
        text = r"We obtain $\Gamma = 4.07$ MeV for the total width."
        result = filter_message(text)
        assert result.blocked_count > 0

    def test_think_not_blocked_after_fix(self):
        """'I think we should use Monte Carlo' should NOT be blocked (VERDICT removed 'think')."""
        text = "I think we should use Monte Carlo integration for this calculation."
        result = filter_message(text)
        assert result.blocked_count == 0

    def test_believe_not_blocked_after_fix(self):
        """'I believe MS-bar is best' should NOT be blocked (VERDICT removed 'believe')."""
        text = "I believe the MS-bar scheme is best for this problem."
        result = filter_message(text)
        assert result.blocked_count == 0

    def test_derivation_is_correct_blocked(self):
        """'This derivation is correct' should still be blocked (VERDICT)."""
        text = "This derivation is correct and matches the expected form."
        result = filter_message(text)
        assert result.blocked_count > 0
        assert result.blocked_spans[0].block_type == "VERDICT"

    def test_your_result_is_wrong_blocked(self):
        """'Your result is wrong' should be blocked (VERDICT or NUM_RESULT)."""
        text = "Your result is wrong — the sign should be negative."
        result = filter_message(text)
        assert result.blocked_count > 0
        # May match NUM_RESULT ("result is") before VERDICT — either is correct

    def test_output_total_colon_number(self):
        """'Total: 3.14159' must be blocked (NUM_RESULT)."""
        text = "Total: 3.14159"
        result = filter_message(text)
        assert result.blocked_count > 0
        assert result.blocked_spans[0].block_type == "NUM_RESULT"

    def test_width_is_number_gev(self):
        """'The width is 4.07 MeV' must be blocked (NUM_RESULT)."""
        text = "The width is 4.07 MeV."
        result = filter_message(text)
        assert result.blocked_count > 0
        assert result.blocked_spans[0].block_type == "NUM_RESULT"


# ===========================================================================
# Regression: R2 review-swarm bypass vectors (Codex-identified)
# ===========================================================================

class TestR2BypassRegressions:
    """Regression tests for bypass vectors found in review-swarm R2."""

    def test_plain_text_symbolic_result(self):
        """'The amplitude is A = g^2/(16*pi^2).' must be blocked (SYM_RESULT) without $...$."""
        text = "The amplitude is A = g^2/(16*pi^2)."
        result = filter_message(text)
        assert result.blocked_count > 0

    def test_positive_signed_numeric(self):
        """'The cross section is +42 pb.' must be blocked (NUM_RESULT)."""
        text = "The cross section is +42 pb."
        result = filter_message(text)
        assert result.blocked_count > 0

    def test_positive_signed_width(self):
        """'The width is +4.07 MeV.' must be blocked (NUM_RESULT)."""
        text = "The width is +4.07 MeV."
        result = filter_message(text)
        assert result.blocked_count > 0

    def test_looks_correct_verdict(self):
        """'Looks correct to me.' must be blocked (VERDICT)."""
        text = "Looks correct to me."
        result = filter_message(text)
        assert result.blocked_count > 0
        assert result.blocked_spans[0].block_type == "VERDICT"

    def test_seems_wrong_verdict(self):
        """'This seems wrong.' must be blocked (VERDICT)."""
        text = "This seems wrong."
        result = filter_message(text)
        assert result.blocked_count > 0
        assert result.blocked_spans[0].block_type == "VERDICT"

    def test_appears_valid_verdict(self):
        """'Appears valid.' must be blocked (VERDICT)."""
        text = "The calculation appears valid in this regime."
        result = filter_message(text)
        assert result.blocked_count > 0

    def test_positive_equals_assignment(self):
        """'= +3.14' must be blocked (NUM_RESULT)."""
        text = "The coupling constant = +3.14."
        result = filter_message(text)
        assert result.blocked_count > 0


# ===========================================================================
# Regression: R3 review-swarm bypass vectors (Codex + Gemini)
# ===========================================================================

class TestR3BypassRegressions:
    """Regression tests for bypass vectors found in review-swarm R3."""

    # --- Plural pronoun "We" bypasses (Gemini #1, Codex #4) ---

    def test_we_find_cross_section(self):
        """'We find a cross section of 42 pb' must be blocked."""
        text = "We find a cross section of 42 pb."
        result = filter_message(text)
        assert result.blocked_count > 0

    def test_we_agree_with_member(self):
        """'We agree with Member B' must be blocked (AGREEMENT or NUM_RESULT via 'result')."""
        text = "We agree with Member B's approach."
        result = filter_message(text)
        assert result.blocked_count > 0
        # May match via "result" in NUM_RESULT or AGREEMENT — either is correct blocking

    def test_we_obtain_result(self):
        """'We obtain a cross section of 42 pb' must be blocked."""
        text = "We obtain a cross section of 42 pb from the numerical integration."
        result = filter_message(text)
        assert result.blocked_count > 0

    def test_we_conclude_blocked(self):
        """'We conclude that...' must be blocked (VERDICT)."""
        text = "We conclude that the leading-order result is sufficient."
        result = filter_message(text)
        assert result.blocked_count > 0
        # May match NUM_RESULT ("result is") before VERDICT — either is correct blocking

    # --- "of" / "equals" assignment bypasses (Gemini #2, Codex #3) ---

    def test_mass_equals_125_gev(self):
        """'The mass equals 125.1 GeV' must be blocked (NUM_RESULT)."""
        text = "The mass equals 125.1 GeV."
        result = filter_message(text)
        assert result.blocked_count > 0

    def test_comes_out_to_42_pb(self):
        """'cross section comes out to 42 pb' must be blocked (NUM_RESULT)."""
        text = "The cross section comes out to 42 pb."
        result = filter_message(text)
        assert result.blocked_count > 0

    def test_width_comes_out_as_4_mev(self):
        """'width comes out as 4.07 MeV' must be blocked (NUM_RESULT)."""
        text = "The width comes out as 4.07 MeV."
        result = filter_message(text)
        assert result.blocked_count > 0

    def test_result_equals_scientific_notation(self):
        """'Result equals +4.2e-3' must be blocked (NUM_RESULT)."""
        text = "The result equals 4.2e-3."
        result = filter_message(text)
        assert result.blocked_count > 0

    # --- Math-mode number shielding (Gemini #3) ---

    def test_math_mode_number_blocked(self):
        """'The cross section is $42$ pb' must be blocked (NUM_RESULT)."""
        text = "The cross section is $42$ pb."
        result = filter_message(text)
        assert result.blocked_count > 0

    # --- LaTeX macro symbolic result (Codex #2) ---

    def test_mathcal_M_assignment(self):
        r"""'The amplitude is \mathcal{M} = ...' must be blocked (SYM_RESULT)."""
        text = r"The amplitude is \mathcal{M} = g^2/(16 pi^2)."
        result = filter_message(text)
        assert result.blocked_count > 0

    def test_matrix_element_equals_mathcal(self):
        r"""'The matrix element equals \mathcal M = ...' must be blocked."""
        text = r"The matrix element equals \mathcal{M} = e^2."
        result = filter_message(text)
        assert result.blocked_count > 0

    # --- Verdict/agreement synonyms (Codex #4) ---

    def test_i_concur_blocked(self):
        """'I concur with your conclusion' must be blocked (VERDICT or AGREEMENT)."""
        text = "I concur with your conclusion."
        result = filter_message(text)
        assert result.blocked_count > 0

    def test_compared_with_calculation(self):
        """'Compared with your calculation, mine is larger' must be blocked (COMPARISON)."""
        text = "Compared with your calculation, mine is larger."
        result = filter_message(text)
        assert result.blocked_count > 0

    def test_validates_your_result(self):
        """'This validates your result' must be blocked (VERDICT)."""
        text = "This validates your result from the previous step."
        result = filter_message(text)
        assert result.blocked_count > 0

    def test_we_concur_with(self):
        """'We concur with your approach' must be blocked (AGREEMENT)."""
        text = "We concur with your approach on this matter."
        result = filter_message(text)
        assert result.blocked_count > 0

    def test_of_value_with_unit(self):
        """'a cross section of 42 pb' must be blocked (NUM_RESULT)."""
        text = "We measure a cross section of 42 pb."
        result = filter_message(text)
        assert result.blocked_count > 0


# ===========================================================================
# Regression: R4 review-swarm bypass vectors (Codex + Gemini)
# ===========================================================================

class TestR4BypassRegressions:
    """Regression tests for bypass vectors found in review-swarm R4."""

    # --- Standalone numeric payloads (Codex #1) ---

    def test_standalone_42_pb(self):
        """'42 pb' alone must be blocked (NUM_RESULT)."""
        text = "42 pb"
        result = filter_message(text)
        assert result.blocked_count > 0

    def test_we_got_42_pb(self):
        """'We got 42 pb.' must be blocked (NUM_RESULT)."""
        text = "We got 42 pb."
        result = filter_message(text)
        assert result.blocked_count > 0

    # --- Plain X = expr symbolic (Codex #2) ---

    def test_plain_symbolic_A_equals(self):
        """'A = g^2/(16*pi^2).' must be blocked (SYM_RESULT)."""
        text = "A = g^2/(16*pi^2)."
        result = filter_message(text)
        assert result.blocked_count > 0

    # --- Lowercase confirmed/challenged (Codex #3) ---

    def test_lowercase_confirmed(self):
        """'step verdict: confirmed' must be blocked (VERDICT)."""
        text = "step verdict: confirmed"
        result = filter_message(text)
        assert result.blocked_count > 0

    # --- Adverb injection bypasses (Gemini #2) ---

    def test_is_exactly_42_pb(self):
        """'The cross section is exactly 42 pb.' must be blocked (NUM_RESULT)."""
        text = "The cross section is exactly 42 pb."
        result = filter_message(text)
        assert result.blocked_count > 0

    def test_looks_completely_correct(self):
        """'looks completely correct.' must be blocked (VERDICT)."""
        text = "This looks completely correct."
        result = filter_message(text)
        assert result.blocked_count > 0

    def test_derivation_is_perfectly_correct(self):
        """'The derivation is perfectly correct.' must be blocked (VERDICT)."""
        text = "The derivation is perfectly correct."
        result = filter_message(text)
        assert result.blocked_count > 0

    def test_evaluates_asymptotically_to(self):
        """'evaluates asymptotically to 42' must be blocked (NUM_RESULT)."""
        text = "The integral evaluates asymptotically to 42."
        result = filter_message(text)
        assert result.blocked_count > 0

    # --- Method suggestion NOT falsely blocked ---

    def test_method_suggestion_not_blocked(self):
        """Pure method suggestion should still pass through."""
        text = "Consider using scipy.integrate for the numerical integration."
        result = filter_message(text)
        assert result.blocked_count == 0


class TestR5BypassRegressions:
    """R5 bypass regressions: SYM_RESULT false positives, unitless numerics,
    verdict phrasings, fenced code with 'text' tag."""

    # --- SYM_RESULT false positive fix (Gemini #1: re.I on [A-Z]) ---

    def test_lowercase_a_equals_b_not_blocked(self):
        """'where a = b + c' must NOT be blocked (lowercase variable)."""
        text = "where a = b + c"
        result = filter_message(text)
        assert result.blocked_count == 0

    def test_mass_equals_symbolic_not_blocked(self):
        """'mass = m_1 + m_2' must NOT be blocked (lowercase variable, symbolic not numeric)."""
        text = "mass = m_1 + m_2"
        result = filter_message(text)
        # After re.I fix: SYM_RESULT [A-Z] patterns no longer match lowercase 'mass'.
        # NUM_RESULT observable pattern requires digits after '=', not letters.
        assert result.blocked_count == 0

    def test_the_equals_sign_not_blocked(self):
        """'the = sign is used here' must NOT be blocked (grammar, not assignment)."""
        text = "the = sign is used here"
        result = filter_message(text)
        assert result.blocked_count == 0

    def test_where_variable_lowercase_pass(self):
        """'where x = some_function(t)' must NOT be blocked (lowercase x)."""
        text = "where x = some_function(t)"
        result = filter_message(text)
        assert result.blocked_count == 0

    def test_uppercase_A_still_blocked(self):
        """'A = g^2/(16*pi^2)' must still be blocked (uppercase variable)."""
        text = "A = g^2/(16*pi^2)."
        result = filter_message(text)
        assert result.blocked_count > 0

    # --- Unitless numerics (Codex #1) ---

    def test_branching_ratio_is_number(self):
        """'The branching ratio is 0.034' must be blocked (dimensionless observable)."""
        text = "The branching ratio is 0.034 for this channel."
        result = filter_message(text)
        assert result.blocked_count > 0

    def test_coefficient_is_number(self):
        """'The coefficient is 2.5' must be blocked (dimensionless observable)."""
        text = "The coefficient is 2.5 in this approximation."
        result = filter_message(text)
        assert result.blocked_count > 0

    def test_phase_angle_is_number(self):
        """'The phase angle is 1.57' must be blocked."""
        text = "The phase angle is 1.57."
        result = filter_message(text)
        assert result.blocked_count > 0

    # --- Verdict phrasings (Codex #3) ---

    def test_checks_out_blocked(self):
        """'Your approach checks out.' must be blocked (VERDICT)."""
        text = "Your approach checks out."
        result = filter_message(text)
        assert result.blocked_count > 0

    def test_i_approve_blocked(self):
        """'I approve this result.' must be blocked (VERDICT)."""
        text = "I approve this result."
        result = filter_message(text)
        assert result.blocked_count > 0

    # --- CODE_OUTPUT with 'text' fence label (Codex #2) ---

    def test_text_fenced_code_blocked(self):
        """'```text\\n42\\n```' must be blocked (CODE_OUTPUT)."""
        text = "```text\n42\n```"
        result = filter_message(text)
        assert result.blocked_count > 0

    # --- TeV and inverse units (Gemini NON-BLOCKING #1) ---

    def test_tev_unit_blocked(self):
        """'14 TeV' must be blocked (standalone number + TeV)."""
        text = "The center-of-mass energy is 14 TeV."
        result = filter_message(text)
        assert result.blocked_count > 0

    def test_fb_inverse_blocked(self):
        """'137 fb^-1' must be blocked (standalone number + fb^-1)."""
        text = "The integrated luminosity is 137 fb^-1."
        result = filter_message(text)
        assert result.blocked_count > 0

