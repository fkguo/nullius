from __future__ import annotations

import re

import pytest

from report_contract_fixtures import complete_report, error_codes, validate_single_report


@pytest.mark.parametrize(
    ("old", "new", "code"),
    [
        (
            "- Human-readable evidence chain: [Documented in the linked evidence with scope and rationale.](../evidence.md) → [Documented in the linked evidence with scope and rationale.](../evidence.md)",
            "- Human-readable evidence chain: [machine receipt](../run.json)",
            "machine_provenance_substitutes_for_human_evidence",
        ),
        (
            "- Derivation chain: Documented in the linked evidence with scope and rationale.",
            "- Derivation chain: [machine receipt](../run.json)",
            "machine_provenance_substitutes_for_narrative",
        ),
    ],
)
def test_machine_provenance_cannot_replace_human_narrative(old: str, new: str, code: str) -> None:
    result = validate_single_report(
        complete_report("report-a").replace(old, new),
        extra_files={"run.json": "{}\n"},
    )

    assert result["status"] == "fail"
    assert code in error_codes(result)


@pytest.mark.parametrize("environment", ["same", "different"])
def test_same_implementation_and_input_is_replay(environment: str) -> None:
    report = complete_report("report-a")
    report = report.replace("- Implementation relation: `different`", "- Implementation relation: `same`")
    report = report.replace("- Input relation: `different`", "- Input relation: `same`")
    report = report.replace("- Environment relation: `different`", f"- Environment relation: `{environment}`")
    result = validate_single_report(report)

    assert result["status"] == "fail"
    assert "same_implementation_replay_claimed_independent" in error_codes(result)


@pytest.mark.parametrize("extra", ["`replay`", ""])
def test_duplicate_validation_classification_fails_closed(extra: str) -> None:
    report = complete_report("report-a").replace(
        "- Classification: `independent`",
        f"- Classification: `independent`\n- Classification: {extra}",
        1,
    )
    result = validate_single_report(report)

    assert result["status"] == "fail"
    assert "validation_field_not_unique" in error_codes(result)


def test_placeholder_validation_record_id_fails_closed() -> None:
    report = re.sub(
        r"^### Validation record: .+$",
        "### Validation record: <validation-id>",
        complete_report("report-a"),
        count=1,
        flags=re.MULTILINE,
    )
    result = validate_single_report(report)

    assert result["status"] == "fail"
    assert "incomplete_validation_record_id" in error_codes(result)


def test_duplicate_validation_record_id_fails_closed() -> None:
    report = complete_report("report-a")
    start = report.index("### Validation record:")
    end = report.index("<!-- REPORT_SECTION_VALIDATION_END -->")
    report = report[:end] + report[start:end] + report[end:]
    result = validate_single_report(report)

    assert result["status"] == "fail"
    assert "validation_record_id_not_unique" in error_codes(result)


def test_empty_validation_record_heading_fails_closed() -> None:
    report = complete_report("report-a").replace(
        "<!-- REPORT_SECTION_VALIDATION_END -->",
        "### Validation record:\n<!-- REPORT_SECTION_VALIDATION_END -->",
        1,
    )
    result = validate_single_report(report)

    assert result["status"] == "fail"
    assert "incomplete_validation_record_id" in error_codes(result)


def test_independent_validation_and_risk_targeted_replay_can_coexist() -> None:
    replay = """
### Validation record: replay-external-state

- Classification: `replay`
- Implementation relation: `same`
- Input relation: `same`
- Environment relation: `different`
- Method or representation difference: No methodological difference; the environment change isolates declared external state.
- Declared replay risks: `external_state`
- Validation result: The replay tested the declared risk and preserved the recorded result.
- Human-readable validation evidence: [Replay evidence](../evidence.md)
"""
    report = complete_report("report-a").replace(
        "<!-- REPORT_SECTION_VALIDATION_END -->",
        replay + "\n<!-- REPORT_SECTION_VALIDATION_END -->",
    )

    assert validate_single_report(report)["status"] == "pass"
