from __future__ import annotations

import hashlib
import re
from dataclasses import dataclass
from pathlib import Path


REGISTRY_START = "<!-- MAIN_RESEARCH_REPORT_REGISTRY_START -->"
REGISTRY_END = "<!-- MAIN_RESEARCH_REPORT_REGISTRY_END -->"
SAFE_REPORT_ID = re.compile(r"^[a-z0-9][a-z0-9._-]*$")
MARKDOWN_LINK = re.compile(r"\[[^\]]+\]\(([^)]+)\)")


@dataclass(frozen=True)
class RegistryRow:
    report_id: str
    target: str
    sha256: str
    supersedes: str
    superseded_by: str


@dataclass(frozen=True)
class RegistryState:
    current_id: str
    current_target: str
    rows: dict[str, RegistryRow]
    paths: dict[str, Path]
    errors: list[dict[str, str]]


def _issue(code: str, message: str, path: str = "project_index.md") -> dict[str, str]:
    return {"code": code, "path": path, "message": message}


def _between(text: str) -> str | None:
    if text.count(REGISTRY_START) != 1 or text.count(REGISTRY_END) != 1:
        return None
    start = text.index(REGISTRY_START) + len(REGISTRY_START)
    end = text.index(REGISTRY_END)
    return text[start:end] if start < end else None


def _values(block: str, label: str) -> list[str]:
    return [
        match.strip().strip("`")
        for match in re.findall(rf"^- {re.escape(label)}:\s*(.+?)\s*$", block, re.MULTILINE)
    ]


def _link_target(value: str) -> str:
    match = MARKDOWN_LINK.search(value)
    return match.group(1).strip() if match else ""


def _parse_rows(block: str, errors: list[dict[str, str]]) -> dict[str, RegistryRow]:
    rows: dict[str, RegistryRow] = {}
    for line in block.splitlines():
        if not line.strip().startswith("|"):
            continue
        cells = [cell.strip() for cell in line.strip().strip("|").split("|")]
        if len(cells) != 5 or cells[0] in {"Report ID", "---"} or set(cells[0]) == {"-"}:
            continue
        report_id = cells[0].strip("`")
        target = _link_target(cells[1])
        sha256 = cells[2].strip("`")
        supersedes = cells[3].strip("`")
        superseded_by = cells[4].strip("`")
        if report_id in rows:
            errors.append(_issue("duplicate_report_id", f"duplicate registry row for {report_id}"))
            continue
        rows[report_id] = RegistryRow(report_id, target, sha256, supersedes, superseded_by)
    return rows


def _resolve_target(project_root: Path, row: RegistryRow, errors: list[dict[str, str]]) -> Path | None:
    if not row.target or row.target.startswith(("/", "file:", "http:", "https:")):
        errors.append(_issue("invalid_report_target", f"{row.report_id} must use a project-relative Markdown link"))
        return None
    target = Path(row.target.split("#", 1)[0])
    if ".." in target.parts:
        errors.append(_issue("invalid_report_target", f"{row.report_id} target cannot contain parent traversal"))
        return None
    candidate = project_root / target
    cursor = candidate
    while cursor != project_root:
        if cursor.is_symlink():
            errors.append(_issue("invalid_report_file", f"{row.report_id} target must be a regular non-template Markdown file"))
            return None
        cursor = cursor.parent
    if cursor != project_root:
        errors.append(_issue("invalid_report_file", f"{row.report_id} target must be a regular non-template Markdown file"))
        return None
    path = candidate.resolve()
    try:
        path.relative_to(project_root)
    except ValueError:
        errors.append(_issue("report_target_escapes_project", f"{row.report_id} target escapes the project root"))
        return None
    try:
        path.relative_to(project_root / "reports")
    except ValueError:
        errors.append(_issue("report_target_outside_reports", f"{row.report_id} target must stay under reports/"))
        return None
    if not path.is_file() or path.suffix.lower() != ".md" or path.name.endswith("_template.md"):
        errors.append(_issue("invalid_report_file", f"{row.report_id} target must be a regular non-template Markdown file"))
        return None
    return path


def _check_relations(rows: dict[str, RegistryRow], current_id: str, errors: list[dict[str, str]]) -> None:
    for row in rows.values():
        if row.supersedes != "none":
            prior = rows.get(row.supersedes)
            if prior is None or prior.superseded_by != row.report_id:
                errors.append(_issue("broken_supersession_relation", f"{row.report_id} and {row.supersedes} do not record both relation directions"))
        if row.superseded_by != "none":
            successor = rows.get(row.superseded_by)
            if successor is None or successor.supersedes != row.report_id:
                errors.append(_issue("broken_supersession_relation", f"{row.report_id} and {row.superseded_by} do not record both relation directions"))
    heads = [row.report_id for row in rows.values() if row.superseded_by == "none"]
    if len(heads) != 1 or heads[0] != current_id:
        errors.append(_issue("current_report_not_chain_head", "the current entry point must target the unique unsuperseded report"))
        return
    visited: set[str] = set()
    cursor = current_id
    while cursor != "none" and cursor in rows and cursor not in visited:
        visited.add(cursor)
        cursor = rows[cursor].supersedes
    if cursor != "none" or visited != set(rows):
        errors.append(_issue("invalid_supersession_chain", "registered reports must form one acyclic supersession chain"))


def load_report_registry(project_root: Path) -> RegistryState:
    root = project_root.expanduser().resolve()
    index = root / "project_index.md"
    errors: list[dict[str, str]] = []
    if not index.is_file():
        return RegistryState("", "", {}, {}, [_issue("missing_project_index", "project_index.md is required")])
    block = _between(index.read_text(encoding="utf-8", errors="replace"))
    if block is None:
        return RegistryState("", "", {}, {}, [_issue("invalid_registry_markers", "the report registry markers must occur once and in order")])
    current_ids = _values(block, "Current report ID")
    current_reports = _values(block, "Current report")
    if len(current_ids) != 1 or len(current_reports) != 1:
        errors.append(_issue("current_report_pointer_not_unique", "the registry must declare exactly one current report ID and link"))
    current_id = current_ids[0] if current_ids else ""
    current_target = _link_target(current_reports[0]) if current_reports else ""
    rows = _parse_rows(block, errors)
    if not current_id or current_id == "(none yet)" or not current_target:
        errors.append(_issue("no_current_report", "no main research report is promoted"))
        return RegistryState(current_id, current_target, rows, {}, errors)
    if not SAFE_REPORT_ID.fullmatch(current_id) or current_id not in rows:
        errors.append(_issue("invalid_current_report_id", "the current report ID must be safe and registered"))
    paths: dict[str, Path] = {}
    for row in rows.values():
        if not SAFE_REPORT_ID.fullmatch(row.report_id) or not re.fullmatch(r"[0-9a-f]{64}", row.sha256):
            errors.append(_issue("invalid_registry_row", f"{row.report_id} has an invalid ID or SHA-256"))
            continue
        path = _resolve_target(root, row, errors)
        if path is not None:
            paths[row.report_id] = path
            digest = hashlib.sha256(path.read_bytes()).hexdigest()
            if digest != row.sha256:
                errors.append(_issue("registered_report_mutated", f"{row.report_id} no longer matches its immutable SHA-256", row.target))
    if current_id in rows and rows[current_id].target != current_target:
        errors.append(_issue("current_report_target_mismatch", "the current report link does not match its registry row"))
    if current_id in rows:
        _check_relations(rows, current_id, errors)
    return RegistryState(current_id, current_target, rows, paths, errors)
