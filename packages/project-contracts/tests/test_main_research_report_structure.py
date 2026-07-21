from __future__ import annotations

import pytest

from report_contract_fixtures import complete_report, error_codes, validate_single_report
from project_contracts.scaffold_template_loader import load_scaffold_template


def test_complete_main_report_passes_structural_validation() -> None:
    result = validate_single_report()

    assert result["status"] == "pass"
    assert result["registered_report_count"] == 1


@pytest.mark.parametrize(
    ("old", "new", "code"),
    [
        ("# Main research report: report-a\n", "", "main_report_title_not_unique"),
        ("# Main research report: report-a", "# Main research report: <REPORT_TITLE>", "incomplete_main_report_title"),
        (
            "# Main research report: report-a",
            "# Main research report: report-a\n# Main research report: contradiction",
            "main_report_title_not_unique",
        ),
        (
            "# Main research report: report-a",
            "# Main research report: report-a\n# Main research report:",
            "main_report_title_not_unique",
        ),
    ],
)
def test_main_report_title_failures(old: str, new: str, code: str) -> None:
    result = validate_single_report(complete_report("report-a").replace(old, new, 1))

    assert result["status"] == "fail"
    assert code in error_codes(result)


def test_template_instructions_do_not_leak_into_researcher_facing_report() -> None:
    template = load_scaffold_template("main_research_report_template.md")
    report = complete_report("report-a")
    for phrase in (
        "Copy this template",
        "Do not promote this template",
        "Passing the structural validator",
        "Add one record per validation",
        "For a replay record",
    ):
        assert phrase not in template
        assert phrase not in report


@pytest.mark.parametrize("extra", ["`contradiction`", ""])
def test_duplicate_visible_report_id_in_metadata_fails_closed(extra: str) -> None:
    report = complete_report("report-a").replace(
        "- Report ID: `report-a`",
        f"- Report ID: `report-a`\n- Report ID: {extra}",
        1,
    )
    result = validate_single_report(report)

    assert result["status"] == "fail"
    assert "report_metadata_field_not_unique" in error_codes(result)


def test_authoring_process_prose_cannot_survive_report_promotion() -> None:
    report = complete_report("report-a").replace(
        "<!-- REPORT_SECTION_ORIGIN_START -->",
        "Copy this template before promotion.\n\n<!-- REPORT_SECTION_ORIGIN_START -->",
    )
    result = validate_single_report(report)

    assert result["status"] == "fail"
    assert "authoring_process_leaked_into_report" in error_codes(result)


@pytest.mark.parametrize(("move", "code"), [(True, "report_field_wrong_section"), (False, "report_field_not_unique")])
def test_required_field_is_bound_to_one_authoritative_section(move: bool, code: str) -> None:
    field = "- Derivation chain: Documented in the linked evidence with scope and rationale."
    report = complete_report("report-a")
    if move:
        report = report.replace(field, "", 1)
    report = report.replace("<!-- REPORT_SECTION_ORIGIN_END -->", field + "\n<!-- REPORT_SECTION_ORIGIN_END -->")
    result = validate_single_report(report)

    assert result["status"] == "fail"
    assert code in error_codes(result)


def test_short_closeout_summary_cannot_masquerade_as_main_report() -> None:
    summary = """# Accepted

<!-- MAIN_RESEARCH_REPORT_METADATA_START -->
- Report kind: `main_research_report`
- Report ID: `report-a`
- Created: `2026-07-21`
- Supersedes report ID: `none`
- Relation registry: [registry](../project_index.md#main-research-report)
<!-- MAIN_RESEARCH_REPORT_METADATA_END -->

Accepted; all checks passed.
"""
    result = validate_single_report(summary)

    assert result["status"] == "fail"
    assert "missing_report_section" in error_codes(result)
