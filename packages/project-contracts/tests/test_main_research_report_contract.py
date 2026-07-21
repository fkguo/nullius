from __future__ import annotations

import hashlib
import re
import sys
import tempfile
from pathlib import Path


SRC_ROOT = Path(__file__).resolve().parents[1] / "src"
sys.path.insert(0, str(SRC_ROOT))

from project_contracts.main_research_report import validate_main_research_report
from project_contracts.scaffold_template_loader import load_scaffold_template


def _complete_report(report_id: str, supersedes: str = "none") -> str:
    text = load_scaffold_template("main_research_report_template.md")
    text = text.replace("<REPORT_TITLE>", report_id)
    text = text.replace("<report-id>", report_id)
    text = text.replace("<YYYY-MM-DD>", "2026-07-21")
    text = text.replace("- Supersedes report ID: `none`", f"- Supersedes report ID: `{supersedes}`")
    text = text.replace("(<relative-or-stable-web-target>)", "(../evidence.md)")
    text = re.sub(r"<(?!\!--)[^>\n]+>", "Documented in the linked evidence with scope and rationale.", text)
    return text


def _write_report(root: Path, report_id: str, *, supersedes: str = "none", text: str | None = None) -> tuple[str, str]:
    reports = root / "reports"
    reports.mkdir(parents=True, exist_ok=True)
    path = reports / f"{report_id}.md"
    path.write_text(text or _complete_report(report_id, supersedes), encoding="utf-8")
    return f"reports/{report_id}.md", hashlib.sha256(path.read_bytes()).hexdigest()


def _write_registry(root: Path, current_id: str, rows: list[tuple[str, str, str, str, str]]) -> None:
    current_path = next(path for report_id, path, *_ in rows if report_id == current_id)
    table = "\n".join(
        f"| `{report_id}` | [{report_id}]({path}) | `{digest}` | `{supersedes}` | `{superseded_by}` |"
        for report_id, path, digest, supersedes, superseded_by in rows
    )
    (root / "project_index.md").write_text(
        "\n".join(
            [
                "# project_index.md",
                "",
                "## Main research report",
                "",
                "<!-- MAIN_RESEARCH_REPORT_REGISTRY_START -->",
                f"- Current report ID: `{current_id}`",
                f"- Current report: [{current_id}]({current_path})",
                "",
                "| Report ID | Report | SHA-256 | Supersedes | Superseded by |",
                "|---|---|---|---|---|",
                table,
                "<!-- MAIN_RESEARCH_REPORT_REGISTRY_END -->",
                "",
            ]
        ),
        encoding="utf-8",
    )


def _error_codes(result: dict[str, object]) -> set[str]:
    raw_errors = result.get("errors")
    assert isinstance(raw_errors, list)
    codes: set[str] = set()
    for item in raw_errors:
        assert isinstance(item, dict)
        code = item.get("code")
        assert isinstance(code, str)
        codes.add(code)
    return codes


def test_complete_main_report_passes_structural_validation() -> None:
    with tempfile.TemporaryDirectory() as td:
        root = Path(td)
        (root / "evidence.md").write_text("# Evidence\n", encoding="utf-8")
        path, digest = _write_report(root, "report-a")
        _write_registry(root, "report-a", [("report-a", path, digest, "none", "none")])
        result = validate_main_research_report(root)

    assert result["status"] == "pass"
    assert result["registered_report_count"] == 1


def test_missing_main_report_title_fails_closed() -> None:
    with tempfile.TemporaryDirectory() as td:
        root = Path(td)
        (root / "evidence.md").write_text("# Evidence\n", encoding="utf-8")
        report = _complete_report("report-a").replace("# Main research report: report-a\n", "", 1)
        path, digest = _write_report(root, "report-a", text=report)
        _write_registry(root, "report-a", [("report-a", path, digest, "none", "none")])
        result = validate_main_research_report(root)

    assert result["status"] == "fail"
    assert "main_report_title_not_unique" in _error_codes(result)


def test_placeholder_main_report_title_fails_closed() -> None:
    with tempfile.TemporaryDirectory() as td:
        root = Path(td)
        (root / "evidence.md").write_text("# Evidence\n", encoding="utf-8")
        report = _complete_report("report-a").replace(
            "# Main research report: report-a",
            "# Main research report: <REPORT_TITLE>",
            1,
        )
        path, digest = _write_report(root, "report-a", text=report)
        _write_registry(root, "report-a", [("report-a", path, digest, "none", "none")])
        result = validate_main_research_report(root)

    assert result["status"] == "fail"
    assert "incomplete_main_report_title" in _error_codes(result)


def test_duplicate_main_report_title_fails_closed() -> None:
    with tempfile.TemporaryDirectory() as td:
        root = Path(td)
        (root / "evidence.md").write_text("# Evidence\n", encoding="utf-8")
        report = _complete_report("report-a").replace(
            "# Main research report: report-a",
            "# Main research report: report-a\n# Main research report: contradiction",
            1,
        )
        path, digest = _write_report(root, "report-a", text=report)
        _write_registry(root, "report-a", [("report-a", path, digest, "none", "none")])
        result = validate_main_research_report(root)

    assert result["status"] == "fail"
    assert "main_report_title_not_unique" in _error_codes(result)


def test_empty_duplicate_main_report_title_fails_closed() -> None:
    with tempfile.TemporaryDirectory() as td:
        root = Path(td)
        (root / "evidence.md").write_text("# Evidence\n", encoding="utf-8")
        report = _complete_report("report-a").replace(
            "# Main research report: report-a",
            "# Main research report: report-a\n# Main research report:",
            1,
        )
        path, digest = _write_report(root, "report-a", text=report)
        _write_registry(root, "report-a", [("report-a", path, digest, "none", "none")])
        result = validate_main_research_report(root)

    assert result["status"] == "fail"
    assert "main_report_title_not_unique" in _error_codes(result)


def test_template_instructions_do_not_leak_into_researcher_facing_report() -> None:
    template = load_scaffold_template("main_research_report_template.md")
    report = _complete_report("report-a")
    forbidden = (
        "Copy this template",
        "Do not promote this template",
        "Passing the structural validator",
        "Add one record per validation",
        "For a replay record",
    )
    for phrase in forbidden:
        assert phrase not in template
        assert phrase not in report


def test_duplicate_visible_report_id_in_metadata_fails_closed() -> None:
    with tempfile.TemporaryDirectory() as td:
        root = Path(td)
        (root / "evidence.md").write_text("# Evidence\n", encoding="utf-8")
        report = _complete_report("report-a").replace(
            "- Report ID: `report-a`",
            "- Report ID: `report-a`\n- Report ID: `contradiction`",
            1,
        )
        path, digest = _write_report(root, "report-a", text=report)
        _write_registry(root, "report-a", [("report-a", path, digest, "none", "none")])
        result = validate_main_research_report(root)

    assert result["status"] == "fail"
    assert "report_metadata_field_not_unique" in _error_codes(result)


def test_empty_duplicate_metadata_field_fails_closed() -> None:
    with tempfile.TemporaryDirectory() as td:
        root = Path(td)
        (root / "evidence.md").write_text("# Evidence\n", encoding="utf-8")
        report = _complete_report("report-a").replace(
            "- Report ID: `report-a`",
            "- Report ID: `report-a`\n- Report ID:",
            1,
        )
        path, digest = _write_report(root, "report-a", text=report)
        _write_registry(root, "report-a", [("report-a", path, digest, "none", "none")])
        result = validate_main_research_report(root)

    assert result["status"] == "fail"
    assert "report_metadata_field_not_unique" in _error_codes(result)


def test_authoring_process_prose_cannot_survive_report_promotion() -> None:
    with tempfile.TemporaryDirectory() as td:
        root = Path(td)
        (root / "evidence.md").write_text("# Evidence\n", encoding="utf-8")
        report = _complete_report("report-a").replace(
            "<!-- REPORT_SECTION_ORIGIN_START -->",
            "Copy this template before promotion.\n\n<!-- REPORT_SECTION_ORIGIN_START -->",
        )
        path, digest = _write_report(root, "report-a", text=report)
        _write_registry(root, "report-a", [("report-a", path, digest, "none", "none")])
        result = validate_main_research_report(root)

    assert result["status"] == "fail"
    assert "authoring_process_leaked_into_report" in _error_codes(result)


def test_report_structure_inside_fenced_code_does_not_count() -> None:
    with tempfile.TemporaryDirectory() as td:
        root = Path(td)
        (root / "evidence.md").write_text("# Evidence\n", encoding="utf-8")
        fenced = "# Accepted\n\n```markdown\n" + _complete_report("report-a") + "\n```\n\nAccepted; all checks passed.\n"
        path, digest = _write_report(root, "report-a", text=fenced)
        _write_registry(root, "report-a", [("report-a", path, digest, "none", "none")])
        result = validate_main_research_report(root)

    assert result["status"] == "fail"
    assert "missing_report_metadata" in _error_codes(result)
    assert "missing_report_section" in _error_codes(result)


def test_required_field_inside_html_comment_does_not_count() -> None:
    with tempfile.TemporaryDirectory() as td:
        root = Path(td)
        (root / "evidence.md").write_text("# Evidence\n", encoding="utf-8")
        report = _complete_report("report-a").replace(
            "- Definitions: Documented in the linked evidence with scope and rationale.",
            "<!--\n- Definitions: Hidden text must not satisfy the narrative contract.\n-->",
            1,
        )
        path, digest = _write_report(root, "report-a", text=report)
        _write_registry(root, "report-a", [("report-a", path, digest, "none", "none")])
        result = validate_main_research_report(root)

    assert result["status"] == "fail"
    assert "incomplete_report_field" in _error_codes(result)


def test_visible_report_with_an_ordinary_code_example_still_passes() -> None:
    with tempfile.TemporaryDirectory() as td:
        root = Path(td)
        (root / "evidence.md").write_text("# Evidence\n", encoding="utf-8")
        example = """
```markdown
Copy this template.
<!-- REPORT_SECTION_RESULTS_START -->
- Definitions: This code example is not report structure.
<!-- REPORT_SECTION_RESULTS_END -->
```
"""
        report = _complete_report("report-a").replace(
            "<!-- REPORT_SECTION_METHOD_END -->",
            example + "\n<!-- REPORT_SECTION_METHOD_END -->",
        )
        path, digest = _write_report(root, "report-a", text=report)
        _write_registry(root, "report-a", [("report-a", path, digest, "none", "none")])
        result = validate_main_research_report(root)

    assert result["status"] == "pass"


def test_required_field_moved_to_the_wrong_section_fails_closed() -> None:
    with tempfile.TemporaryDirectory() as td:
        root = Path(td)
        (root / "evidence.md").write_text("# Evidence\n", encoding="utf-8")
        field = "- Derivation chain: Documented in the linked evidence with scope and rationale."
        report = _complete_report("report-a").replace(field, "", 1).replace(
            "<!-- REPORT_SECTION_ORIGIN_END -->",
            field + "\n<!-- REPORT_SECTION_ORIGIN_END -->",
        )
        path, digest = _write_report(root, "report-a", text=report)
        _write_registry(root, "report-a", [("report-a", path, digest, "none", "none")])
        result = validate_main_research_report(root)

    assert result["status"] == "fail"
    assert "report_field_wrong_section" in _error_codes(result)


def test_required_field_copied_into_another_section_is_not_unique() -> None:
    with tempfile.TemporaryDirectory() as td:
        root = Path(td)
        (root / "evidence.md").write_text("# Evidence\n", encoding="utf-8")
        field = "- Derivation chain: Documented in the linked evidence with scope and rationale."
        report = _complete_report("report-a").replace(
            "<!-- REPORT_SECTION_ORIGIN_END -->",
            field + "\n<!-- REPORT_SECTION_ORIGIN_END -->",
        )
        path, digest = _write_report(root, "report-a", text=report)
        _write_registry(root, "report-a", [("report-a", path, digest, "none", "none")])
        result = validate_main_research_report(root)

    assert result["status"] == "fail"
    assert "report_field_not_unique" in _error_codes(result)


def test_short_closeout_summary_cannot_masquerade_as_main_report() -> None:
    with tempfile.TemporaryDirectory() as td:
        root = Path(td)
        summary = """# Accepted\n\n<!-- MAIN_RESEARCH_REPORT_METADATA_START -->\n- Report kind: `main_research_report`\n- Report ID: `report-a`\n- Created: `2026-07-21`\n- Supersedes report ID: `none`\n- Relation registry: [registry](../project_index.md#main-research-report)\n<!-- MAIN_RESEARCH_REPORT_METADATA_END -->\n\nAccepted; all checks passed.\n"""
        path, digest = _write_report(root, "report-a", text=summary)
        _write_registry(root, "report-a", [("report-a", path, digest, "none", "none")])
        result = validate_main_research_report(root)

    assert result["status"] == "fail"
    assert "missing_report_section" in _error_codes(result)


def test_superseding_report_requires_current_entry_point_switch() -> None:
    with tempfile.TemporaryDirectory() as td:
        root = Path(td)
        (root / "evidence.md").write_text("# Evidence\n", encoding="utf-8")
        old_path, old_hash = _write_report(root, "report-old")
        new_path, new_hash = _write_report(root, "report-new", supersedes="report-old")
        _write_registry(
            root,
            "report-old",
            [
                ("report-old", old_path, old_hash, "none", "report-new"),
                ("report-new", new_path, new_hash, "report-old", "none"),
            ],
        )
        result = validate_main_research_report(root)

    assert result["status"] == "fail"
    assert "current_report_not_chain_head" in _error_codes(result)


def test_current_report_can_supersede_a_structurally_incomplete_history() -> None:
    with tempfile.TemporaryDirectory() as td:
        root = Path(td)
        (root / "evidence.md").write_text("# Evidence\n", encoding="utf-8")
        old = """# Earlier report\n\n<!-- MAIN_RESEARCH_REPORT_METADATA_START -->\n- Report kind: `main_research_report`\n- Report ID: `report-old`\n- Created: `2026-07-20`\n- Supersedes report ID: `none`\n- Relation registry: [registry](../project_index.md#main-research-report)\n<!-- MAIN_RESEARCH_REPORT_METADATA_END -->\n\nEarlier account.\n"""
        old_path, old_hash = _write_report(root, "report-old", text=old)
        new_path, new_hash = _write_report(root, "report-new", supersedes="report-old")
        _write_registry(
            root,
            "report-new",
            [
                ("report-old", old_path, old_hash, "none", "report-new"),
                ("report-new", new_path, new_hash, "report-old", "none"),
            ],
        )
        result = validate_main_research_report(root)

    assert result["status"] == "pass"


def test_machine_provenance_cannot_replace_human_evidence() -> None:
    with tempfile.TemporaryDirectory() as td:
        root = Path(td)
        (root / "evidence.md").write_text("# Evidence\n", encoding="utf-8")
        (root / "run.json").write_text("{}\n", encoding="utf-8")
        report = _complete_report("report-a").replace(
            "- Human-readable evidence chain: [Documented in the linked evidence with scope and rationale.](../evidence.md) → [Documented in the linked evidence with scope and rationale.](../evidence.md)",
            "- Human-readable evidence chain: [machine receipt](../run.json)",
        )
        path, digest = _write_report(root, "report-a", text=report)
        _write_registry(root, "report-a", [("report-a", path, digest, "none", "none")])
        result = validate_main_research_report(root)

    assert result["status"] == "fail"
    assert "machine_provenance_substitutes_for_human_evidence" in _error_codes(result)


def test_machine_provenance_cannot_replace_explanatory_narrative() -> None:
    with tempfile.TemporaryDirectory() as td:
        root = Path(td)
        (root / "evidence.md").write_text("# Evidence\n", encoding="utf-8")
        (root / "run.json").write_text("{}\n", encoding="utf-8")
        report = _complete_report("report-a").replace(
            "- Derivation chain: Documented in the linked evidence with scope and rationale.",
            "- Derivation chain: [machine receipt](../run.json)",
        )
        path, digest = _write_report(root, "report-a", text=report)
        _write_registry(root, "report-a", [("report-a", path, digest, "none", "none")])
        result = validate_main_research_report(root)

    assert result["status"] == "fail"
    assert "machine_provenance_substitutes_for_narrative" in _error_codes(result)


def test_current_report_pointer_must_be_declared_once() -> None:
    with tempfile.TemporaryDirectory() as td:
        root = Path(td)
        (root / "evidence.md").write_text("# Evidence\n", encoding="utf-8")
        path, digest = _write_report(root, "report-a")
        _write_registry(root, "report-a", [("report-a", path, digest, "none", "none")])
        index = root / "project_index.md"
        index.write_text(
            index.read_text(encoding="utf-8").replace(
                "- Current report ID: `report-a`",
                "- Current report ID: `report-a`\n- Current report ID: `report-a`",
            ),
            encoding="utf-8",
        )
        result = validate_main_research_report(root)

    assert result["status"] == "fail"
    assert "current_report_pointer_not_unique" in _error_codes(result)


def test_registry_inside_fenced_code_does_not_count() -> None:
    with tempfile.TemporaryDirectory() as td:
        root = Path(td)
        (root / "evidence.md").write_text("# Evidence\n", encoding="utf-8")
        path, digest = _write_report(root, "report-a")
        _write_registry(root, "report-a", [("report-a", path, digest, "none", "none")])
        index = root / "project_index.md"
        index.write_text(
            "# project_index.md\n\n```markdown\n" + index.read_text(encoding="utf-8") + "```\n",
            encoding="utf-8",
        )
        result = validate_main_research_report(root)

    assert result["status"] == "fail"
    assert "invalid_registry_markers" in _error_codes(result)


def test_registry_data_inside_html_comment_does_not_count() -> None:
    with tempfile.TemporaryDirectory() as td:
        root = Path(td)
        (root / "evidence.md").write_text("# Evidence\n", encoding="utf-8")
        path, digest = _write_report(root, "report-a")
        _write_registry(root, "report-a", [("report-a", path, digest, "none", "none")])
        index = root / "project_index.md"
        text = index.read_text(encoding="utf-8")
        text = text.replace(
            "<!-- MAIN_RESEARCH_REPORT_REGISTRY_START -->",
            "<!-- MAIN_RESEARCH_REPORT_REGISTRY_START -->\n<!--",
        ).replace(
            "<!-- MAIN_RESEARCH_REPORT_REGISTRY_END -->",
            "-->\n<!-- MAIN_RESEARCH_REPORT_REGISTRY_END -->",
        )
        index.write_text(text, encoding="utf-8")
        result = validate_main_research_report(root)

    assert result["status"] == "fail"
    assert "current_report_pointer_not_unique" in _error_codes(result)
    assert "no_current_report" in _error_codes(result)


def test_current_report_pointer_must_contain_one_markdown_link() -> None:
    with tempfile.TemporaryDirectory() as td:
        root = Path(td)
        (root / "evidence.md").write_text("# Evidence\n", encoding="utf-8")
        path, digest = _write_report(root, "report-a")
        _write_registry(root, "report-a", [("report-a", path, digest, "none", "none")])
        index = root / "project_index.md"
        index.write_text(
            index.read_text(encoding="utf-8").replace(
                f"- Current report: [report-a]({path})",
                f"- Current report: [report-a]({path}) [contradiction](reports/contradiction.md)",
            ),
            encoding="utf-8",
        )
        result = validate_main_research_report(root)

    assert result["status"] == "fail"
    assert "current_report_link_not_unique" in _error_codes(result)


def test_empty_duplicate_current_report_pointer_fails_closed() -> None:
    with tempfile.TemporaryDirectory() as td:
        root = Path(td)
        (root / "evidence.md").write_text("# Evidence\n", encoding="utf-8")
        path, digest = _write_report(root, "report-a")
        _write_registry(root, "report-a", [("report-a", path, digest, "none", "none")])
        index = root / "project_index.md"
        index.write_text(
            index.read_text(encoding="utf-8").replace(
                f"- Current report: [report-a]({path})",
                f"- Current report: [report-a]({path})\n- Current report:",
            ),
            encoding="utf-8",
        )
        result = validate_main_research_report(root)

    assert result["status"] == "fail"
    assert "current_report_pointer_not_unique" in _error_codes(result)


def test_registry_report_cell_must_contain_one_markdown_link() -> None:
    with tempfile.TemporaryDirectory() as td:
        root = Path(td)
        (root / "evidence.md").write_text("# Evidence\n", encoding="utf-8")
        path, digest = _write_report(root, "report-a")
        _write_registry(root, "report-a", [("report-a", path, digest, "none", "none")])
        index = root / "project_index.md"
        index.write_text(
            index.read_text(encoding="utf-8").replace(
                f"| `report-a` | [report-a]({path}) |",
                f"| `report-a` | [report-a]({path}) [contradiction](reports/contradiction.md) |",
            ),
            encoding="utf-8",
        )
        result = validate_main_research_report(root)

    assert result["status"] == "fail"
    assert "registry_report_link_not_unique" in _error_codes(result)


def test_same_implementation_replay_is_not_independent_validation() -> None:
    with tempfile.TemporaryDirectory() as td:
        root = Path(td)
        (root / "evidence.md").write_text("# Evidence\n", encoding="utf-8")
        report = _complete_report("report-a")
        report = report.replace("- Implementation relation: `different`", "- Implementation relation: `same`")
        report = report.replace("- Input relation: `different`", "- Input relation: `same`")
        report = report.replace("- Environment relation: `different`", "- Environment relation: `same`")
        path, digest = _write_report(root, "report-a", text=report)
        _write_registry(root, "report-a", [("report-a", path, digest, "none", "none")])
        result = validate_main_research_report(root)

    assert result["status"] == "fail"
    assert "same_implementation_replay_claimed_independent" in _error_codes(result)


def test_duplicate_validation_classification_fails_closed() -> None:
    with tempfile.TemporaryDirectory() as td:
        root = Path(td)
        (root / "evidence.md").write_text("# Evidence\n", encoding="utf-8")
        report = _complete_report("report-a").replace(
            "- Classification: `independent`",
            "- Classification: `independent`\n- Classification: `replay`",
            1,
        )
        path, digest = _write_report(root, "report-a", text=report)
        _write_registry(root, "report-a", [("report-a", path, digest, "none", "none")])
        result = validate_main_research_report(root)

    assert result["status"] == "fail"
    assert "validation_field_not_unique" in _error_codes(result)


def test_empty_duplicate_validation_field_fails_closed() -> None:
    with tempfile.TemporaryDirectory() as td:
        root = Path(td)
        (root / "evidence.md").write_text("# Evidence\n", encoding="utf-8")
        report = _complete_report("report-a").replace(
            "- Classification: `independent`",
            "- Classification: `independent`\n- Classification:",
            1,
        )
        path, digest = _write_report(root, "report-a", text=report)
        _write_registry(root, "report-a", [("report-a", path, digest, "none", "none")])
        result = validate_main_research_report(root)

    assert result["status"] == "fail"
    assert "validation_field_not_unique" in _error_codes(result)


def test_placeholder_validation_record_id_fails_closed() -> None:
    with tempfile.TemporaryDirectory() as td:
        root = Path(td)
        (root / "evidence.md").write_text("# Evidence\n", encoding="utf-8")
        report = re.sub(
            r"^### Validation record: .+$",
            "### Validation record: <validation-id>",
            _complete_report("report-a"),
            count=1,
            flags=re.MULTILINE,
        )
        path, digest = _write_report(root, "report-a", text=report)
        _write_registry(root, "report-a", [("report-a", path, digest, "none", "none")])
        result = validate_main_research_report(root)

    assert result["status"] == "fail"
    assert "incomplete_validation_record_id" in _error_codes(result)


def test_duplicate_validation_record_id_fails_closed() -> None:
    with tempfile.TemporaryDirectory() as td:
        root = Path(td)
        (root / "evidence.md").write_text("# Evidence\n", encoding="utf-8")
        report = _complete_report("report-a")
        start = report.index("### Validation record:")
        end = report.index("<!-- REPORT_SECTION_VALIDATION_END -->")
        record = report[start:end]
        report = report[:end] + record + report[end:]
        path, digest = _write_report(root, "report-a", text=report)
        _write_registry(root, "report-a", [("report-a", path, digest, "none", "none")])
        result = validate_main_research_report(root)

    assert result["status"] == "fail"
    assert "validation_record_id_not_unique" in _error_codes(result)


def test_empty_validation_record_heading_fails_closed() -> None:
    with tempfile.TemporaryDirectory() as td:
        root = Path(td)
        (root / "evidence.md").write_text("# Evidence\n", encoding="utf-8")
        report = _complete_report("report-a").replace(
            "<!-- REPORT_SECTION_VALIDATION_END -->",
            "### Validation record:\n<!-- REPORT_SECTION_VALIDATION_END -->",
            1,
        )
        path, digest = _write_report(root, "report-a", text=report)
        _write_registry(root, "report-a", [("report-a", path, digest, "none", "none")])
        result = validate_main_research_report(root)

    assert result["status"] == "fail"
    assert "incomplete_validation_record_id" in _error_codes(result)


def test_hidden_contradictory_values_do_not_count() -> None:
    with tempfile.TemporaryDirectory() as td:
        root = Path(td)
        (root / "evidence.md").write_text("# Evidence\n", encoding="utf-8")
        report = _complete_report("report-a").replace(
            "<!-- MAIN_RESEARCH_REPORT_METADATA_END -->",
            "<!--\n- Report ID: `contradiction`\n-->\n<!-- MAIN_RESEARCH_REPORT_METADATA_END -->",
        ).replace(
            "- Classification: `independent`",
            "- Classification: `independent`\n<!-- - Classification: `replay` -->",
            1,
        )
        path, digest = _write_report(root, "report-a", text=report)
        _write_registry(root, "report-a", [("report-a", path, digest, "none", "none")])
        index = root / "project_index.md"
        index.write_text(
            index.read_text(encoding="utf-8").replace(
                f"- Current report: [report-a]({path})",
                f"- Current report: [report-a]({path}) <!-- [contradiction](reports/contradiction.md) -->",
            ).replace(
                f"| `report-a` | [report-a]({path}) |",
                f"| `report-a` | [report-a]({path}) <!-- [contradiction](reports/contradiction.md) --> |",
            ),
            encoding="utf-8",
        )
        result = validate_main_research_report(root)

    assert result["status"] == "pass"


def test_environment_change_does_not_make_same_implementation_and_input_independent() -> None:
    with tempfile.TemporaryDirectory() as td:
        root = Path(td)
        (root / "evidence.md").write_text("# Evidence\n", encoding="utf-8")
        report = _complete_report("report-a")
        report = report.replace("- Implementation relation: `different`", "- Implementation relation: `same`")
        report = report.replace("- Input relation: `different`", "- Input relation: `same`")
        path, digest = _write_report(root, "report-a", text=report)
        _write_registry(root, "report-a", [("report-a", path, digest, "none", "none")])
        result = validate_main_research_report(root)

    assert result["status"] == "fail"
    assert "same_implementation_replay_claimed_independent" in _error_codes(result)


def test_independent_validation_and_risk_targeted_replay_can_coexist() -> None:
    with tempfile.TemporaryDirectory() as td:
        root = Path(td)
        (root / "evidence.md").write_text("# Evidence\n", encoding="utf-8")
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
        report = _complete_report("report-a").replace(
            "<!-- REPORT_SECTION_VALIDATION_END -->",
            replay + "\n<!-- REPORT_SECTION_VALIDATION_END -->",
        )
        path, digest = _write_report(root, "report-a", text=report)
        _write_registry(root, "report-a", [("report-a", path, digest, "none", "none")])
        result = validate_main_research_report(root)

    assert result["status"] == "pass"


def test_registered_historical_report_is_immutable() -> None:
    with tempfile.TemporaryDirectory() as td:
        root = Path(td)
        (root / "evidence.md").write_text("# Evidence\n", encoding="utf-8")
        path, digest = _write_report(root, "report-a")
        _write_registry(root, "report-a", [("report-a", path, digest, "none", "none")])
        (root / path).write_text((root / path).read_text(encoding="utf-8") + "\nChanged.\n", encoding="utf-8")
        result = validate_main_research_report(root)

    assert result["status"] == "fail"
    assert "registered_report_mutated" in _error_codes(result)
