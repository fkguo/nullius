from __future__ import annotations

import re
from pathlib import Path
from typing import Any

from .markdown_visibility import visible_markdown
from .report_registry import MARKDOWN_LINK, RegistryRow, load_report_registry
from .report_field_validation import (
    field_is_filled,
    field_values,
    first_field,
    human_links,
    machine_only_reference,
    validate_validation_section,
)


METADATA_START = "<!-- MAIN_RESEARCH_REPORT_METADATA_START -->"
METADATA_END = "<!-- MAIN_RESEARCH_REPORT_METADATA_END -->"
SECTION_NAMES = (
    "ORIGIN", "OBJECT", "FOUNDATIONS", "SOURCES", "DERIVATION", "DESIGN",
    "METHOD", "RESULTS", "VALIDATION", "BALANCE", "IMPACT", "EVIDENCE",
)
STRUCTURAL_MARKERS = {
    METADATA_START,
    METADATA_END,
    *(f"<!-- REPORT_SECTION_{name}_{edge} -->" for name in SECTION_NAMES for edge in ("START", "END")),
}
REQUIRED_FIELDS_BY_SECTION = {
    "ORIGIN": ("Origin of the question", "Relation to prior work or adjacent hypotheses"),
    "OBJECT": ("Research object", "Observables", "Representation coordinates", "Object-observable-coordinate distinctions"),
    "FOUNDATIONS": ("Definitions", "Conventions", "Domain of applicability", "Load-bearing assumptions"),
    "SOURCES": ("Primary-source and full-text coverage", "Provenance for load-bearing claims", "Unread or unavailable source material"),
    "DERIVATION": ("Starting premises", "Derivation chain", "Exact results", "Controlled approximations", "Model assumptions"),
    "DESIGN": ("Predeclared question", "Inputs", "Parameter axes", "Acceptance criteria", "Rejection criteria"),
    "METHOD": ("Quantity definitions", "Reconstruction method", "Method limitations"),
    "RESULTS": ("Complete results", "Bias magnitude", "Uncertainty and resolution", "Boundary cases", "Counterexamples"),
    "BALANCE": ("Supporting evidence", "Opposing evidence", "Strongest alternative explanation", "Exact scope of the conclusion"),
    "IMPACT": ("Impact on the research question or idea state", "Next falsifiable condition"),
    "EVIDENCE": ("Human-readable evidence chain", "Machine provenance", "Binding explanation"),
}
AUTHORING_PROCESS_PHRASES = (
    "copy this template",
    "do not promote this template",
    "passing the structural validator",
    "add one record per validation",
    "for a replay record",
)
METADATA_FIELDS = (
    "Report kind",
    "Report ID",
    "Created",
    "Supersedes report ID",
    "Relation registry",
)


def _issue(code: str, message: str, path: str) -> dict[str, str]:
    return {"code": code, "path": path, "message": message}


def _between(text: str, start: str, end: str) -> str | None:
    if text.count(start) != 1 or text.count(end) != 1:
        return None
    left = text.index(start) + len(start)
    right = text.index(end)
    return text[left:right] if left < right else None


def _metadata(text: str) -> dict[str, str] | None:
    block = _between(text, METADATA_START, METADATA_END)
    if block is None:
        return None
    return {
        "kind": first_field(block, "Report kind").strip("`"),
        "id": first_field(block, "Report ID").strip("`"),
        "created": first_field(block, "Created").strip("`"),
        "supersedes": first_field(block, "Supersedes report ID").strip("`"),
        "registry": first_field(block, "Relation registry"),
    }


def _validate_metadata(text: str, row: RegistryRow, path: Path, root: Path, errors: list[dict[str, str]]) -> None:
    rel = path.relative_to(root).as_posix()
    visible_text = visible_markdown(text, preserved_markers=STRUCTURAL_MARKERS)
    block = _between(visible_text, METADATA_START, METADATA_END)
    if block is None:
        errors.append(_issue("missing_report_metadata", "report metadata markers are missing or duplicated", rel))
        return
    not_unique = [label for label in METADATA_FIELDS if len(field_values(block, label)) != 1]
    if not_unique:
        errors.append(_issue("report_metadata_field_not_unique", f"metadata fields must occur exactly once: {', '.join(not_unique)}", rel))
        return
    meta = _metadata(visible_text)
    assert meta is not None
    if meta["kind"] != "main_research_report" or meta["id"] != row.report_id or meta["supersedes"] != row.supersedes:
        errors.append(_issue("report_registry_metadata_mismatch", "report kind, ID, or supersedes metadata disagrees with the registry", rel))
    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", meta["created"]):
        errors.append(_issue("invalid_report_created_date", "Created must use YYYY-MM-DD", rel))
    links = MARKDOWN_LINK.findall(meta["registry"])
    if len(links) != 1 or not links[0].endswith("project_index.md#main-research-report") or not human_links(meta["registry"], path, root):
        errors.append(_issue("missing_relation_registry_link", "every report must link back to the supersession registry", rel))


def _validate_current_report(path: Path, root: Path, errors: list[dict[str, str]]) -> None:
    rel = path.relative_to(root).as_posix()
    text = path.read_text(encoding="utf-8", errors="replace")
    visible_text = visible_markdown(text, preserved_markers=STRUCTURAL_MARKERS)
    titles = [item.strip() for item in re.findall(r"^# Main research report:[ \t]*(.*?)[ \t]*$", visible_text, re.MULTILINE)]
    if len(titles) != 1:
        errors.append(_issue("main_report_title_not_unique", "the report must contain exactly one visible main research report title", rel))
    elif not field_is_filled(titles[0]):
        errors.append(_issue("incomplete_main_report_title", "the visible main research report title must be filled", rel))
    leaked = [phrase for phrase in AUTHORING_PROCESS_PHRASES if phrase in visible_text.lower()]
    if leaked:
        errors.append(_issue("authoring_process_leaked_into_report", "researcher-facing reports cannot retain template or structural-validator instructions", rel))
    sections: dict[str, str] = {}
    for name in SECTION_NAMES:
        section = _between(visible_text, f"<!-- REPORT_SECTION_{name}_START -->", f"<!-- REPORT_SECTION_{name}_END -->")
        if section is None:
            errors.append(_issue("missing_report_section", f"required section {name} is missing or duplicated", rel))
        else:
            sections[name] = section
    for section_name, labels in REQUIRED_FIELDS_BY_SECTION.items():
        section = sections.get(section_name, "")
        for label in labels:
            all_values = field_values(visible_text, label)
            scoped_values = field_values(section, label)
            if not all_values:
                errors.append(_issue("incomplete_report_field", f"required field is missing: {label}", rel))
                continue
            if len(all_values) != 1:
                errors.append(_issue("report_field_not_unique", f"required field must occur exactly once: {label}", rel))
                continue
            if len(scoped_values) != 1:
                errors.append(_issue("report_field_wrong_section", f"required field must occur in section {section_name}: {label}", rel))
                continue
            value = scoped_values[0]
            if not field_is_filled(value):
                errors.append(_issue("incomplete_report_field", f"required field is unfilled: {label}", rel))
            elif label not in {"Human-readable evidence chain", "Machine provenance"} and machine_only_reference(value):
                errors.append(_issue("machine_provenance_substitutes_for_narrative", f"machine references cannot replace explanatory narrative: {label}", rel))
    evidence = first_field(sections.get("EVIDENCE", ""), "Human-readable evidence chain")
    if evidence and not human_links(evidence, path, root):
        errors.append(_issue("machine_provenance_substitutes_for_human_evidence", "the evidence chain needs a reachable human-readable link; machine references do not count", rel))
    validate_validation_section(sections.get("VALIDATION", ""), path, root, rel, errors)


def validate_main_research_report(project_root: Path) -> dict[str, Any]:
    root = project_root.expanduser().resolve()
    registry = load_report_registry(root)
    errors = list(registry.errors)
    for report_id, path in registry.paths.items():
        text = path.read_text(encoding="utf-8", errors="replace")
        _validate_metadata(text, registry.rows[report_id], path, root, errors)
    current_path = registry.paths.get(registry.current_id)
    if current_path is not None:
        _validate_current_report(current_path, root, errors)
    return {
        "contract": "main_research_report_v1",
        "status": "pass" if not errors else "fail",
        "current_report_id": registry.current_id or None,
        "current_report_path": registry.current_target or None,
        "registered_report_count": len(registry.rows),
        "errors": errors,
        "judgment_boundary": "Structural validation does not establish scientific sufficiency.",
    }
