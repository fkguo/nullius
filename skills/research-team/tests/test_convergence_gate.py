#!/usr/bin/env python3
"""Golden fixture tests for check_team_convergence.py.

Tests the core parsing functions directly (unit tests) without requiring
a real research_team_config.json — we test the internal functions, not
the CLI entry point which depends on load_team_config().
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

# Make gate module importable
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts" / "gates"))
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts" / "lib"))

from check_team_convergence import (
    NONTRIVIALITY_REASONS,
    ReportStatus,
    _extract_section,
    _has_independent_derivation,
    _is_converged,
    _parse_comparison,
    _parse_nontriviality_reason,
    _parse_step_verdicts,
    _parse_sweep_semantics,
    _parse_verdict,
    _validate_nontriviality,
    check_convergence,
)


# ---------------------------------------------------------------------------
# Default token tuples (English-only, matching DEFAULT_CONFIG)
# ---------------------------------------------------------------------------
PASS_TOKENS = ("pass", "通过", "合格")
FAIL_TOKENS = ("fail", "失败", "不合格")
READY_TOKENS = ("ready for next milestone", "就绪", "可进入下一里程碑")
NEEDS_TOKENS = ("needs revision", "需修改", "需要修改")


# ---------------------------------------------------------------------------
# Helper: build a minimal converged report
# ---------------------------------------------------------------------------
def _make_report(
    *,
    deriv_comp: str = "match",
    comp_comp: str = "match within tolerance",
    verdict: str = "ready for next milestone",
    sweep: str = "pass",
    deriv_table: str = "pass",
    comp_table: str = "pass",
    extra_sections: str = "",
    triviality: str = "NONTRIVIAL",
    nontriviality_fields: str = (
        "Falsification pathway: independent algebraic route\n"
        "Failure mode targeted: sign error in coupling\n"
        "Evidence pointer: eq. (3.2)\n"
    ),
    nontriviality_reason: str = "INDEPENDENT_PATH",
) -> str:
    return f"""\
## Derivation Replication
Starting from: Lagrangian
Key intermediate steps (>=3):
- Step 1: expand
- Step 2: integrate
- Step 3: simplify
My final expression: result
Comparison: {deriv_comp}

## Computation Replication
Target quantity: cross-section
Headline tier (claimed): T1
{nontriviality_fields}Triviality classification: {triviality}
Nontriviality reason: {nontriviality_reason}
Formula: sigma = ...
Inputs: m=125 GeV
My calculation: 0.123
Reported value: 0.123
Comparison: {comp_comp}
Code pointer(s): src/calc.py:42
Artifact(s) checked: results/output.json

## Sweep Semantics / Parameter Dependence
Scanned variables: mu_R
Held-fixed constants: m_b
Dependent recomputations: sigma(mu_R)
Consistency verdict: {sweep}
Notes: all good

## Major Gaps
- none

## Minor Issues
- none

## Novelty & Breakthrough Leads
- Lead 1: test

## Reproduction Summary
| Check | Status | Notes |
|---|---|---|
| Derivation replication | {deriv_table} | ok |
| Computation replication | {comp_table} | ok |

## Minimal Fix List
1. none

## Verdict
- {verdict}
- Blocking issues: none
{extra_sections}"""


# ===========================================================================
# Fixture 1: Both pass — full convergence
# ===========================================================================
class TestFixture1FullConvergence:
    def test_parse_comparison_match(self):
        assert _parse_comparison("Comparison: match — all good\n") == "pass"

    def test_parse_verdict_ready(self):
        text = _make_report()
        assert _parse_verdict(text, READY_TOKENS, NEEDS_TOKENS) == "ready"

    def test_is_converged(self):
        s = ReportStatus(
            path=Path("a.md"), derivation="pass", computation="pass",
            verdict="ready", sweep_semantics="pass",
        )
        assert _is_converged(s, require_sweep=True)

    def test_peer_both_pass(self):
        a = ReportStatus(path=Path("a.md"), derivation="pass", computation="pass", verdict="ready", sweep_semantics="pass")
        b = ReportStatus(path=Path("b.md"), derivation="pass", computation="pass", verdict="ready", sweep_semantics="pass")
        assert check_convergence(a, b, "peer", require_sweep=True) == 0


# ===========================================================================
# Fixture 2: A pass, B fail (Computation fail in table)
# ===========================================================================
class TestFixture2TableFail:
    def test_table_fail(self):
        from check_team_convergence import _parse_pass_fail_from_table
        text = "| Computation replication | **fail** | mismatch |\n"
        assert _parse_pass_fail_from_table(text, "Computation replication", PASS_TOKENS, FAIL_TOKENS) == "fail"

    def test_peer_a_pass_b_fail(self):
        a = ReportStatus(path=Path("a.md"), derivation="pass", computation="pass", verdict="ready", sweep_semantics="pass")
        b = ReportStatus(path=Path("b.md"), derivation="pass", computation="fail", verdict="needs_revision", sweep_semantics="pass")
        assert check_convergence(a, b, "peer", require_sweep=True) == 1


# ===========================================================================
# Fixture 3: Comparison: mismatch (BUG REGRESSION TEST)
# ===========================================================================
class TestFixture3MismatchBug:
    """The original bug: 'mismatch' contains 'match', so both flags were True → 'unknown'.
    After fix: 'mismatch' is checked first → 'fail'."""

    def test_mismatch_returns_fail(self):
        assert _parse_comparison("Comparison: mismatch\n") == "fail"

    def test_mismatch_with_explanation(self):
        assert _parse_comparison("Comparison: mismatch — sign error in amplitude\n") == "fail"

    def test_mismatch_not_unknown(self):
        """Ensure the old buggy behavior (returning 'unknown') is gone."""
        result = _parse_comparison("Comparison: mismatch\n")
        assert result != "unknown"
        assert result == "fail"

    def test_bold_comparison(self):
        """Markdown-decorated **Comparison:** must still parse (R2 fix)."""
        assert _parse_comparison("**Comparison:** match within 0.1%\n") == "pass"

    def test_bullet_comparison(self):
        """Bullet-prefixed comparison must still parse (R2 fix)."""
        assert _parse_comparison("- Comparison: mismatch\n") == "fail"


# ===========================================================================
# Fixture 4: Comparison: match within tolerance
# ===========================================================================
class TestFixture4MatchWithinTolerance:
    def test_match_within_tolerance(self):
        assert _parse_comparison("Comparison: match within tolerance — 0.1% diff\n") == "pass"

    def test_plain_match(self):
        assert _parse_comparison("Comparison: match\n") == "pass"


# ===========================================================================
# Fixture 5: No ## Verdict heading, but ## Final Verdict present
# ===========================================================================
class TestFixture5VerdictVariant:
    def test_final_verdict_heading(self):
        text = """\
## Derivation Replication
Comparison: match

## Final Verdict
- ready for next milestone
- Blocking issues: none
"""
        assert _parse_verdict(text, READY_TOKENS, NEEDS_TOKENS) == "ready"

    def test_chinese_verdict_heading(self):
        text = """\
## 结论
- 就绪
"""
        assert _parse_verdict(text, READY_TOKENS, NEEDS_TOKENS) == "ready"

    def test_summary_heading(self):
        text = """\
## 总结
- 需修改
"""
        assert _parse_verdict(text, READY_TOKENS, NEEDS_TOKENS) == "needs_revision"


# ===========================================================================
# Fixture 6: No ## Verdict heading at all (FULLTEXT FALLBACK ELIMINATION REGRESSION)
# ===========================================================================
class TestFixture6NoVerdictHeading:
    """Without any recognized Verdict heading, must return 'unknown' — never search full text."""

    def test_no_verdict_returns_unknown(self):
        text = """\
## Derivation Replication
Comparison: match

## Computation Replication
Comparison: match

## Sweep Semantics / Parameter Dependence
Consistency verdict: pass

Some text mentioning ready for next milestone and needs revision.
"""
        assert _parse_verdict(text, READY_TOKENS, NEEDS_TOKENS) == "unknown"

    def test_system_prompt_echo_not_matched(self):
        """If LLM echoes system prompt text 'choose needs revision' but has no Verdict heading,
        it must NOT match as needs_revision."""
        text = """\
## Report
Verdict rule (must follow):
- If you report any mismatch, you MUST choose needs revision.

## Derivation Replication
Comparison: match
"""
        assert _parse_verdict(text, READY_TOKENS, NEEDS_TOKENS) == "unknown"


# ===========================================================================
# Fixture 7: Chinese report (通过/失败/就绪/需修改)
# ===========================================================================
class TestFixture7ChineseReport:
    def test_chinese_pass_fail(self):
        from check_team_convergence import _parse_pass_fail_from_table
        text = "| Derivation replication | 通过 | 正确 |\n"
        assert _parse_pass_fail_from_table(text, "Derivation replication", PASS_TOKENS, FAIL_TOKENS) == "pass"

    def test_chinese_fail(self):
        from check_team_convergence import _parse_pass_fail_from_table
        text = "| Computation replication | 失败 | 有误 |\n"
        assert _parse_pass_fail_from_table(text, "Computation replication", PASS_TOKENS, FAIL_TOKENS) == "fail"

    def test_chinese_sweep_pass(self):
        text = """\
## Sweep Semantics / Parameter Dependence
Consistency verdict: 通过
"""
        assert _parse_sweep_semantics(text) == "pass"

    def test_chinese_sweep_fail(self):
        text = """\
## Sweep Semantics / Parameter Dependence
Consistency verdict: 不合格
"""
        assert _parse_sweep_semantics(text) == "fail"


# ===========================================================================
# Fixture 8: Markdown decoration (**pass**, `fail`)
# ===========================================================================
class TestFixture8MarkdownDecoration:
    def test_bold_pass(self):
        from check_team_convergence import _parse_pass_fail_from_table
        text = "| Derivation replication | **pass** | looks good |\n"
        assert _parse_pass_fail_from_table(text, "Derivation replication", PASS_TOKENS, FAIL_TOKENS) == "pass"

    def test_backtick_fail(self):
        from check_team_convergence import _parse_pass_fail_from_table
        text = "| Computation replication | `fail` | mismatch |\n"
        assert _parse_pass_fail_from_table(text, "Computation replication", PASS_TOKENS, FAIL_TOKENS) == "fail"

    def test_bold_sweep_pass(self):
        text = """\
## Sweep Semantics / Parameter Dependence
**Consistency verdict:** ✓ **Pass** — all recomputed
"""
        assert _parse_sweep_semantics(text) == "pass"


# ===========================================================================
# Fixture 9: sweep_semantics missing + require_sweep=False (theory milestone)
# ===========================================================================
class TestFixture9TheoryMilestoneSweepUnknown:
    def test_sweep_unknown_no_require(self):
        s = ReportStatus(
            path=Path("a.md"), derivation="pass", computation="pass",
            verdict="ready", sweep_semantics="unknown",
        )
        assert _is_converged(s, require_sweep=False) is True

    def test_sweep_fail_still_blocks(self):
        """Even without require_sweep, explicit fail blocks."""
        s = ReportStatus(
            path=Path("a.md"), derivation="pass", computation="pass",
            verdict="ready", sweep_semantics="fail",
        )
        assert _is_converged(s, require_sweep=False) is False


# ===========================================================================
# Fixture 10: sweep_semantics missing + require_sweep=True (default strict)
# ===========================================================================
class TestFixture10StrictSweepRequired:
    def test_sweep_unknown_blocks(self):
        s = ReportStatus(
            path=Path("a.md"), derivation="pass", computation="pass",
            verdict="ready", sweep_semantics="unknown",
        )
        assert _is_converged(s, require_sweep=True) is False

    def test_sweep_pass_ok(self):
        s = ReportStatus(
            path=Path("a.md"), derivation="pass", computation="pass",
            verdict="ready", sweep_semantics="pass",
        )
        assert _is_converged(s, require_sweep=True) is True


# ===========================================================================
# Fixture 11: Placeholder report (pass/fail not substituted)
# ===========================================================================
class TestFixture11Placeholder:
    def test_placeholder_comparison(self):
        """'match / mismatch' template text → unknown."""
        assert _parse_comparison("Comparison: {match / mismatch} — notes\n") == "fail"
        # Note: "mismatch" is present → "fail", which is actually correct behavior
        # (the template itself contains "mismatch"). But pure "pass/fail" in table:

    def test_placeholder_table(self):
        """'pass/fail' template text in table → unknown (regex requires word boundary via |)."""
        from check_team_convergence import _parse_pass_fail_from_table
        text = "| Derivation replication | pass/fail | ... |\n"
        result = _parse_pass_fail_from_table(text, "Derivation replication", PASS_TOKENS, FAIL_TOKENS)
        # The regex pattern requires the token to be surrounded by formatting chars / spaces / |
        # "pass/fail" doesn't match cleanly → unknown, which is correct behavior for a placeholder
        assert result == "unknown"

    def test_placeholder_sweep_both_tokens(self):
        """Sweep with both pass and fail tokens → unknown."""
        text = """\
## Sweep Semantics / Parameter Dependence
Consistency verdict: pass / fail
"""
        assert _parse_sweep_semantics(text) == "unknown"


# ===========================================================================
# Fixture 12: Comparison: mismatch with trailing explanation
# ===========================================================================
class TestFixture12MismatchWithExplanation:
    def test_mismatch_sign_error(self):
        assert _parse_comparison("Comparison: mismatch — sign error\n") == "fail"

    def test_mismatch_factor_two(self):
        assert _parse_comparison("Comparison: mismatch (factor of 2 discrepancy)\n") == "fail"

    def test_mismatch_mixed_case(self):
        assert _parse_comparison("Comparison: Mismatch — normalization\n") == "fail"


# ===========================================================================
# Step verdicts (leader/asymmetric mode) — Fixtures 13-15
# ===========================================================================
class TestStepVerdicts:
    def test_parse_confirmed(self):
        text = """\
## Step 1: Lagrangian setup
Starting from the standard model...
Step verdict: CONFIRMED

## Step 2: Loop calculation
One-loop diagrams...
Step verdict: CONFIRMED
"""
        verdicts = _parse_step_verdicts(text)
        assert len(verdicts) == 2
        assert verdicts[0] == ("Step 1: Lagrangian setup", "CONFIRMED")
        assert verdicts[1] == ("Step 2: Loop calculation", "CONFIRMED")

    def test_parse_challenged(self):
        text = """\
## Step 1: Setup
ok
Step verdict: CONFIRMED

## Step 2: Integration
wrong sign
Step verdict: CHALLENGED

## Step 3: Result
depends on step 2
Step verdict: CHALLENGED
"""
        verdicts = _parse_step_verdicts(text)
        assert len(verdicts) == 3
        challenged = [v for _, v in verdicts if v == "CHALLENGED"]
        assert len(challenged) == 2

    def test_leader_early_stop(self):
        a = ReportStatus(path=Path("a.md"), derivation="pass", computation="pass", verdict="ready", sweep_semantics="pass")
        b = ReportStatus(
            path=Path("b.md"), derivation="pass", computation="pass", verdict="ready", sweep_semantics="pass",
            step_verdicts=[("Step 1: Setup", "CONFIRMED"), ("Step 2: Calc", "CHALLENGED"), ("Step 3: Result", "CHALLENGED")],
        )
        assert check_convergence(a, b, "leader", require_sweep=True) == 3

    def test_leader_one_challenged_not_early_stop(self):
        a = ReportStatus(path=Path("a.md"), derivation="pass", computation="pass", verdict="ready", sweep_semantics="pass")
        b = ReportStatus(
            path=Path("b.md"), derivation="pass", computation="pass", verdict="ready", sweep_semantics="pass",
            step_verdicts=[("Step 1: Setup", "CONFIRMED"), ("Step 2: Calc", "CHALLENGED")],
        )
        # 1 CHALLENGED < 2 threshold → not early stop, but still converged if base criteria met
        assert check_convergence(a, b, "leader", require_sweep=True) == 0

    def test_leader_converged(self):
        a = ReportStatus(path=Path("a.md"), derivation="pass", computation="pass", verdict="ready", sweep_semantics="pass")
        b = ReportStatus(
            path=Path("b.md"), derivation="pass", computation="pass", verdict="ready", sweep_semantics="pass",
            step_verdicts=[("Step 1: Setup", "CONFIRMED"), ("Step 2: Calc", "CONFIRMED")],
        )
        assert check_convergence(a, b, "leader", require_sweep=True) == 0

    def test_cross_step_verdict_no_bleed(self):
        """Step without verdict must NOT capture the next step's verdict (R1 fix)."""
        text = """\
## Step 1: Setup
Some setup text.

## Step 2: Calculation
The calculation gives...
Step verdict: CHALLENGED
"""
        verdicts = _parse_step_verdicts(text)
        # Step 1 has NO verdict → should not steal Step 2's verdict
        for name, v in verdicts:
            if "Step 1" in name:
                assert False, f"Step 1 should not have a verdict but got: {v}"
        # Step 2 should have CHALLENGED
        step2 = [v for name, v in verdicts if "Step 2" in name]
        assert step2 == ["CHALLENGED"]

    def test_markdown_decorated_verdict(self):
        """Step verdict with markdown decoration must still be parsed."""
        text = """\
## Step 1: Setup
Some text.
**Step verdict:** CONFIRMED
"""
        verdicts = _parse_step_verdicts(text)
        assert len(verdicts) == 1
        assert verdicts[0][1] == "CONFIRMED"

    def test_verdict_in_non_step_section_no_bleed(self):
        """Verdict in a non-step ## section must not be attributed to the last step (R2 fix)."""
        text = """\
## Step 1: Setup
Some analysis.
Step verdict: CONFIRMED

## Major Gaps
There is a gap. Step verdict: CHALLENGED
"""
        verdicts = _parse_step_verdicts(text)
        assert len(verdicts) == 1
        assert verdicts[0] == ("Step 1: Setup", "CONFIRMED")

    def test_verdict_in_subsection_no_bleed(self):
        """Verdict in a ### sub-section must not be attributed to the previous step (R3 fix)."""
        text = """\
## Step 1: Setup
Some text.

### Major Gaps
There is a gap. Step verdict: CHALLENGED
"""
        verdicts = _parse_step_verdicts(text)
        # Step 1 has NO verdict — the CHALLENGED is under ###, outside step scope
        assert len(verdicts) == 0


# ===========================================================================
# Asymmetric mode — Fixture 16-17
# ===========================================================================
class TestAsymmetricMode:
    def test_asymmetric_no_independent_derivation(self):
        a = ReportStatus(path=Path("a.md"), derivation="pass", computation="pass", verdict="ready", sweep_semantics="pass")
        b = ReportStatus(
            path=Path("b.md"), derivation="pass", computation="pass", verdict="ready", sweep_semantics="pass",
            has_independent_derivation=False,
        )
        assert check_convergence(a, b, "asymmetric", require_sweep=True) == 1

    def test_asymmetric_with_independent_derivation(self):
        a = ReportStatus(path=Path("a.md"), derivation="pass", computation="pass", verdict="ready", sweep_semantics="pass")
        b = ReportStatus(
            path=Path("b.md"), derivation="pass", computation="pass", verdict="ready", sweep_semantics="pass",
            has_independent_derivation=True,
        )
        assert check_convergence(a, b, "asymmetric", require_sweep=True) == 0

    def test_has_independent_derivation_section(self):
        text = """\
## Independent Derivation
Starting from the Dirac equation, I independently derive...
The result is sigma = 0.123 pb.

## Comparison with Leader
My result matches.
"""
        assert _has_independent_derivation(text) is True

    def test_empty_independent_derivation(self):
        text = """\
## Independent Derivation

## Comparison with Leader
"""
        assert _has_independent_derivation(text) is False


# ===========================================================================
# Nontriviality validation — Fixtures 18-21
# ===========================================================================
class TestNontrivialityValidation:
    def test_valid_nontrivial(self):
        text = _make_report()
        assert _validate_nontriviality(text) is True

    def test_trivial_classification(self):
        text = _make_report(triviality="TRIVIAL", nontriviality_fields="", nontriviality_reason="")
        assert _validate_nontriviality(text) is False

    def test_nontrivial_missing_falsification_pathway(self):
        text = _make_report(
            nontriviality_fields=(
                "Failure mode targeted: sign error\n"
                "Evidence pointer: eq. (3.2)\n"
            ),
        )
        assert _validate_nontriviality(text) is False

    def test_nontrivial_missing_failure_mode(self):
        text = _make_report(
            nontriviality_fields=(
                "Falsification pathway: independent route\n"
                "Evidence pointer: eq. (3.2)\n"
            ),
        )
        assert _validate_nontriviality(text) is False

    def test_nontrivial_missing_reason(self):
        text = _make_report(
            nontriviality_fields=(
                "Falsification pathway: independent route\n"
                "Failure mode targeted: sign error\n"
                "Evidence pointer: eq. (3.2)\n"
            ),
            nontriviality_reason="",
        )
        # nontriviality_reason is empty string → Nontriviality reason: \n → empty → False
        assert _validate_nontriviality(text) is False

    def test_parse_reason_controlled_vocab(self):
        for reason in NONTRIVIALITY_REASONS:
            text = _make_report(nontriviality_reason=reason)
            assert _parse_nontriviality_reason(text) == reason

    def test_parse_reason_other(self):
        text = _make_report(nontriviality_reason="OTHER: custom check via lattice QCD")
        assert _parse_nontriviality_reason(text) is not None
        assert _parse_nontriviality_reason(text).startswith("OTHER:")

    def test_parse_reason_invalid(self):
        text = _make_report(nontriviality_reason="FOOBAR")
        assert _parse_nontriviality_reason(text) is None

    def test_invalid_reason_blocks_validation(self):
        """An invalid nontriviality reason must fail _validate_nontriviality (R1 fix)."""
        text = _make_report(nontriviality_reason="FOOBAR")
        # Even though all other fields are present, invalid reason must block
        assert _validate_nontriviality(text) is False

    def test_valid_reason_passes_validation(self):
        """A valid controlled-vocabulary reason passes validation."""
        text = _make_report(nontriviality_reason="INDEPENDENT_PATH")
        assert _validate_nontriviality(text) is True

    def test_other_reason_passes_validation(self):
        """OTHER:* pattern passes validation."""
        text = _make_report(nontriviality_reason="OTHER: custom check")
        assert _validate_nontriviality(text) is True

    def test_empty_other_reason_fails(self):
        """Empty OTHER: (no suffix) must fail validation (R3 fix)."""
        text = _make_report(nontriviality_reason="OTHER:")
        assert _parse_nontriviality_reason(text) is None
        assert _validate_nontriviality(text) is False


# ===========================================================================
# Mode fallback — Fixture 22
# ===========================================================================
class TestModeFallback:
    def test_unknown_mode_falls_back_to_peer(self):
        a = ReportStatus(path=Path("a.md"), derivation="pass", computation="pass", verdict="ready", sweep_semantics="pass")
        b = ReportStatus(path=Path("b.md"), derivation="pass", computation="pass", verdict="ready", sweep_semantics="pass")
        assert check_convergence(a, b, "nonexistent_mode", require_sweep=True) == 0


# ===========================================================================
# Extract section edge cases — Fixture 23
# ===========================================================================
class TestExtractSection:
    def test_last_section_no_trailing_heading(self):
        text = """\
## Verdict
- ready for next milestone
- Blocking issues: none
"""
        sec = _extract_section(text, "Verdict")
        assert "ready for next milestone" in sec

    def test_section_not_found(self):
        text = "## Other\nsome content\n"
        assert _extract_section(text, "Verdict") == ""

    def test_case_insensitive(self):
        text = """\
## VERDICT
- ready for next milestone
"""
        sec = _extract_section(text, "Verdict")
        assert "ready for next milestone" in sec
