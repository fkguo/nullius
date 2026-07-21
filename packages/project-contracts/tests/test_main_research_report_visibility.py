from __future__ import annotations

from report_contract_fixtures import complete_report, error_codes, validate_single_report


def test_report_structure_inside_fenced_code_does_not_count() -> None:
    fenced = "# Accepted\n\n```markdown\n" + complete_report("report-a") + "\n```\n\nAccepted; all checks passed.\n"
    result = validate_single_report(fenced)

    assert result["status"] == "fail"
    assert {"missing_report_metadata", "missing_report_section"} <= error_codes(result)


def test_required_field_inside_html_comment_does_not_count() -> None:
    report = complete_report("report-a").replace(
        "- Definitions: Documented in the linked evidence with scope and rationale.",
        "<!--\n- Definitions: Hidden text must not satisfy the narrative contract.\n-->",
        1,
    )
    result = validate_single_report(report)

    assert result["status"] == "fail"
    assert "incomplete_report_field" in error_codes(result)


def test_visible_report_with_an_ordinary_code_example_still_passes() -> None:
    example = """
```markdown
Copy this template.
<!-- REPORT_SECTION_RESULTS_START -->
- Definitions: This code example is not report structure.
<!-- REPORT_SECTION_RESULTS_END -->
```
"""
    report = complete_report("report-a").replace(
        "<!-- REPORT_SECTION_METHOD_END -->",
        example + "\n<!-- REPORT_SECTION_METHOD_END -->",
    )

    assert validate_single_report(report)["status"] == "pass"


def test_registry_inside_fenced_code_does_not_count() -> None:
    result = validate_single_report(
        index_mutator=lambda text, _: "# project_index.md\n\n```markdown\n" + text + "```\n",
    )

    assert result["status"] == "fail"
    assert "invalid_registry_markers" in error_codes(result)


def test_registry_data_inside_html_comment_does_not_count() -> None:
    def hide_registry(text: str, _: str) -> str:
        return text.replace(
            "<!-- MAIN_RESEARCH_REPORT_REGISTRY_START -->",
            "<!-- MAIN_RESEARCH_REPORT_REGISTRY_START -->\n<!--",
        ).replace("<!-- MAIN_RESEARCH_REPORT_REGISTRY_END -->", "-->\n<!-- MAIN_RESEARCH_REPORT_REGISTRY_END -->")

    result = validate_single_report(index_mutator=hide_registry)

    assert result["status"] == "fail"
    assert {"current_report_pointer_not_unique", "no_current_report"} <= error_codes(result)


def test_hidden_contradictory_values_do_not_count() -> None:
    report = complete_report("report-a").replace(
        "<!-- MAIN_RESEARCH_REPORT_METADATA_END -->",
        "<!--\n- Report ID: `contradiction`\n-->\n<!-- MAIN_RESEARCH_REPORT_METADATA_END -->",
    ).replace(
        "- Classification: `independent`",
        "- Classification: `independent`\n<!-- - Classification: `replay` -->",
        1,
    )

    def hide_index_links(text: str, path: str) -> str:
        return text.replace(
            f"- Current report: [report-a]({path})",
            f"- Current report: [report-a]({path}) <!-- [contradiction](reports/contradiction.md) -->",
        ).replace(
            f"| `report-a` | [report-a]({path}) |",
            f"| `report-a` | [report-a]({path}) <!-- [contradiction](reports/contradiction.md) --> |",
        )

    assert validate_single_report(report, index_mutator=hide_index_links)["status"] == "pass"
