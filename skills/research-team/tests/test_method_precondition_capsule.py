"""Regression lock for the §J Method-validity-precondition gate.

Covers `_has_method_precondition` (added with capsule section J): absent -> None
(backward-compatible warn/require), a concrete `not applicable: <reason>` opt-out
-> True, stub/placeholder opt-outs and field values -> rejected, and a fully
filled load-bearing field set -> True. The gate's label regexes must keep
matching the shipped `assets/derivation_notes_template.md` §J labels.
"""
import sys
from pathlib import Path

import pytest

RESEARCH_TEAM_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(RESEARCH_TEAM_DIR / "scripts" / "gates"))
sys.path.insert(0, str(RESEARCH_TEAM_DIR / "scripts" / "lib"))

import check_reproducibility_capsule as crc  # noqa: E402

HEADER = "### J) Method-validity preconditions (MANDATORY ...; else `not applicable: <reason>`)"


def _capsule(section_body: str) -> str:
    # A minimal capsule carrying only §J, framed like the real template.
    return f"# notes\n\n{HEADER}\n\n{section_body}\n\n### K) Something else\n\nx\n"


FILLED = "\n".join(
    [
        "- Property the method's validity rests on: operator O commutes with projector P",
        "- Disconfirming residual (definition): ‖[P,O]ψ‖/‖Oψ‖ for random ψ",
        "- Configuration that produced the headline number: grid=512, size=L=64",
        "- Residual at that production configuration: 1.3e-14  (threshold: 1e-10)",
        "- Verdict: pass",
    ]
)


def test_absent_section_returns_none():
    # No §J at all -> None (caller warns, or errors only under require_method_precondition).
    assert crc._has_method_precondition("# notes\n\n### A) Goal\n\nx\n") is None


def test_fully_filled_fields_pass():
    assert crc._has_method_precondition(_capsule(FILLED)) is True


def test_filled_with_violated_verdict_still_structurally_valid():
    # The gate validates field PRESENCE/non-stub, not the verdict value itself.
    body = FILLED.replace("- Verdict: pass", "- Verdict: precondition_violated")
    assert crc._has_method_precondition(_capsule(body)) is True


def test_concrete_not_applicable_opt_out_passes():
    body = "not applicable: this milestone reports only a closed-form symbolic identity"
    assert crc._has_method_precondition(_capsule(body)) is True


def test_not_applicable_with_dash_prefix_passes():
    body = "- not applicable: purely analytic continuum result, no discretized operator"
    assert crc._has_method_precondition(_capsule(body)) is True


@pytest.mark.parametrize(
    "reason",
    ["n/a", "N/A", "tbd", "TODO", "none", "<reason>", "...", "----", "short"],
)
def test_stub_or_too_short_not_applicable_reason_is_malformed(reason):
    # A non-reason token, the verbatim template placeholder, or a <12-char reason
    # must NOT be accepted as a conscious opt-out.
    assert crc._has_method_precondition(_capsule(f"not applicable: {reason}")) is False


@pytest.mark.parametrize(
    "bound",
    ["<1e-14 (threshold: 1e-10)", "<=0.01", "< 1e-12", "≤1e-9", "1.3e-14"],
)
def test_numeric_upper_bound_residual_is_not_a_placeholder(bound):
    # A residual reported as an upper bound (`<1e-14`, `<=0.01`) is a LEGITIMATE value — it must not
    # be mistaken for a `<placeholder>` stub. (Only `<word>` like `<value>` is a placeholder.)
    body = FILLED.replace(
        "- Residual at that production configuration: 1.3e-14  (threshold: 1e-10)",
        f"- Residual at that production configuration: {bound}",
    )
    assert crc._has_method_precondition(_capsule(body)) is True


def test_missing_one_required_field_is_malformed():
    body = "\n".join(ln for ln in FILLED.splitlines() if not ln.startswith("- Verdict:"))
    assert crc._has_method_precondition(_capsule(body)) is False


@pytest.mark.parametrize("stub", ["TBD", "<value>", "todo", "n/a", "", "..."])
def test_one_stub_field_value_is_malformed(stub):
    body = FILLED.replace(
        "- Residual at that production configuration: 1.3e-14  (threshold: 1e-10)",
        f"- Residual at that production configuration: {stub}",
    )
    assert crc._has_method_precondition(_capsule(body)) is False


def test_disconfirming_residual_label_variant_matches():
    # The label regex must tolerate the template's "(definition)" qualifier.
    assert "Disconfirming residual (definition)" in FILLED
    assert crc._has_method_precondition(_capsule(FILLED)) is True


def test_template_section_labels_match_the_gate():
    # The shipped template §J must carry exactly the labels the gate requires, or a
    # correctly-filled capsule would false-fail. Lock the template<->gate contract.
    tmpl = (RESEARCH_TEAM_DIR / "assets" / "derivation_notes_template.md").read_text(encoding="utf-8")
    for label in (
        "Property the method's validity rests on:",
        "Disconfirming residual (definition):",
        "Configuration that produced the headline number:",
        "Residual at that production configuration:",
        "Verdict:",
    ):
        assert label in tmpl, f"template missing §J field label: {label!r}"
    assert "### J) Method-validity preconditions" in tmpl
