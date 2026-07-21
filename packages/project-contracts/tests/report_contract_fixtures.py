from __future__ import annotations

import hashlib
import re
import sys
import tempfile
from pathlib import Path
from typing import Callable


SRC_ROOT = Path(__file__).resolve().parents[1] / "src"
sys.path.insert(0, str(SRC_ROOT))

from project_contracts.main_research_report import validate_main_research_report
from project_contracts.scaffold_template_loader import load_scaffold_template


IndexMutator = Callable[[str, str], str]


def complete_report(report_id: str, supersedes: str = "none") -> str:
    text = load_scaffold_template("main_research_report_template.md")
    text = text.replace("<REPORT_TITLE>", report_id)
    text = text.replace("<report-id>", report_id)
    text = text.replace("<YYYY-MM-DD>", "2026-07-21")
    text = text.replace("- Supersedes report ID: `none`", f"- Supersedes report ID: `{supersedes}`")
    text = text.replace("(<relative-or-stable-web-target>)", "(../evidence.md)")
    return re.sub(r"<(?!\!--)[^>\n]+>", "Documented in the linked evidence with scope and rationale.", text)


def write_report(
    root: Path,
    report_id: str,
    *,
    supersedes: str = "none",
    text: str | None = None,
) -> tuple[str, str]:
    reports = root / "reports"
    reports.mkdir(parents=True, exist_ok=True)
    path = reports / f"{report_id}.md"
    path.write_text(complete_report(report_id, supersedes) if text is None else text, encoding="utf-8")
    return f"reports/{report_id}.md", hashlib.sha256(path.read_bytes()).hexdigest()


def write_registry(root: Path, current_id: str, rows: list[tuple[str, str, str, str, str]]) -> None:
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


def error_codes(result: dict[str, object]) -> set[str]:
    errors = result.get("errors")
    assert isinstance(errors, list)
    return {item["code"] for item in errors if isinstance(item, dict) and isinstance(item.get("code"), str)}


def validate_single_report(
    report: str | None = None,
    *,
    index_mutator: IndexMutator | None = None,
    extra_files: dict[str, str] | None = None,
) -> dict[str, object]:
    with tempfile.TemporaryDirectory() as td:
        root = Path(td)
        (root / "evidence.md").write_text("# Evidence\n", encoding="utf-8")
        for relative, text in (extra_files or {}).items():
            target = root / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(text, encoding="utf-8")
        path, digest = write_report(root, "report-a", text=report)
        write_registry(root, "report-a", [("report-a", path, digest, "none", "none")])
        if index_mutator is not None:
            index = root / "project_index.md"
            index.write_text(index_mutator(index.read_text(encoding="utf-8"), path), encoding="utf-8")
        return validate_main_research_report(root)
