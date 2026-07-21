from __future__ import annotations

import tempfile
from pathlib import Path

from report_contract_fixtures import (
    complete_report,
    error_codes,
    validate_main_research_report,
    validate_single_report,
    write_registry,
    write_report,
)


def test_superseding_report_requires_current_entry_point_switch() -> None:
    with tempfile.TemporaryDirectory() as td:
        root = Path(td)
        (root / "evidence.md").write_text("# Evidence\n", encoding="utf-8")
        old_path, old_hash = write_report(root, "report-old")
        new_path, new_hash = write_report(root, "report-new", supersedes="report-old")
        write_registry(
            root,
            "report-old",
            [
                ("report-old", old_path, old_hash, "none", "report-new"),
                ("report-new", new_path, new_hash, "report-old", "none"),
            ],
        )
        result = validate_main_research_report(root)

    assert result["status"] == "fail"
    assert "current_report_not_chain_head" in error_codes(result)


def test_current_report_can_supersede_a_structurally_incomplete_history() -> None:
    with tempfile.TemporaryDirectory() as td:
        root = Path(td)
        (root / "evidence.md").write_text("# Evidence\n", encoding="utf-8")
        old = """# Earlier report

<!-- MAIN_RESEARCH_REPORT_METADATA_START -->
- Report kind: `main_research_report`
- Report ID: `report-old`
- Created: `2026-07-20`
- Supersedes report ID: `none`
- Relation registry: [registry](../project_index.md#main-research-report)
<!-- MAIN_RESEARCH_REPORT_METADATA_END -->

Earlier account.
"""
        old_path, old_hash = write_report(root, "report-old", text=old)
        new_path, new_hash = write_report(root, "report-new", supersedes="report-old")
        write_registry(
            root,
            "report-new",
            [
                ("report-old", old_path, old_hash, "none", "report-new"),
                ("report-new", new_path, new_hash, "report-old", "none"),
            ],
        )
        result = validate_main_research_report(root)

    assert result["status"] == "pass"


def test_current_report_id_must_be_declared_once() -> None:
    result = validate_single_report(
        index_mutator=lambda text, _: text.replace(
            "- Current report ID: `report-a`",
            "- Current report ID: `report-a`\n- Current report ID: `report-a`",
        ),
    )

    assert result["status"] == "fail"
    assert "current_report_pointer_not_unique" in error_codes(result)


def test_current_report_pointer_must_contain_one_markdown_link() -> None:
    result = validate_single_report(
        index_mutator=lambda text, path: text.replace(
            f"- Current report: [report-a]({path})",
            f"- Current report: [report-a]({path}) [contradiction](reports/contradiction.md)",
        ),
    )

    assert result["status"] == "fail"
    assert "current_report_link_not_unique" in error_codes(result)


def test_empty_duplicate_current_report_pointer_fails_closed() -> None:
    result = validate_single_report(
        index_mutator=lambda text, path: text.replace(
            f"- Current report: [report-a]({path})",
            f"- Current report: [report-a]({path})\n- Current report:",
        ),
    )

    assert result["status"] == "fail"
    assert "current_report_pointer_not_unique" in error_codes(result)


def test_registry_report_cell_must_contain_one_markdown_link() -> None:
    result = validate_single_report(
        index_mutator=lambda text, path: text.replace(
            f"| `report-a` | [report-a]({path}) |",
            f"| `report-a` | [report-a]({path}) [contradiction](reports/contradiction.md) |",
        ),
    )

    assert result["status"] == "fail"
    assert "registry_report_link_not_unique" in error_codes(result)


def test_registered_historical_report_is_immutable() -> None:
    with tempfile.TemporaryDirectory() as td:
        root = Path(td)
        (root / "evidence.md").write_text("# Evidence\n", encoding="utf-8")
        path, digest = write_report(root, "report-a")
        write_registry(root, "report-a", [("report-a", path, digest, "none", "none")])
        report_path = root / path
        report_path.write_text(report_path.read_text(encoding="utf-8") + "\nChanged.\n", encoding="utf-8")
        result = validate_main_research_report(root)

    assert result["status"] == "fail"
    assert "registered_report_mutated" in error_codes(result)
