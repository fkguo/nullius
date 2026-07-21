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
