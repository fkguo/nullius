from __future__ import annotations

import re
from pathlib import Path
from typing import Any

from .markdown_visibility import visible_markdown
from .report_registry import MARKDOWN_LINK, RegistryRow, load_report_registry


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
VALIDATION_FIELDS = (
    "Classification", "Implementation relation", "Input relation", "Environment relation",
    "Method or representation difference", "Declared replay risks", "Validation result",
    "Human-readable validation evidence",
)
MACHINE_SUFFIXES = (".json", ".jsonl", ".yaml", ".yml", ".lock")
HUMAN_SUFFIXES = (".md", ".html", ".htm", ".pdf", ".txt")
REPLAY_RISKS = {"randomness", "parallelism", "cache", "external_state", "unfixed_dependencies"}
AUTHORING_PROCESS_PHRASES = (
    "copy this template",
    "do not promote this template",
    "passing the structural validator",
    "add one record per validation",
    "for a replay record",
)


def _issue(code: str, message: str, path: str) -> dict[str, str]:
    return {"code": code, "path": path, "message": message}


def _between(text: str, start: str, end: str) -> str | None:
    if text.count(start) != 1 or text.count(end) != 1:
        return None
    left = text.index(start) + len(start)
    right = text.index(end)
    return text[left:right] if left < right else None


def _field(text: str, label: str) -> str:
    values = _field_values(text, label)
    return values[0] if values else ""


def _field_values(text: str, label: str) -> list[str]:
    return [
        match.strip()
        for match in re.findall(rf"^- {re.escape(label)}:\s*(.+?)\s*$", text, re.MULTILINE)
    ]


def _filled(value: str) -> bool:
    plain = value.strip().strip("`").lower()
    if not plain or plain in {"none", "n/a", "not applicable", "(none yet)", "-"}:
        return False
    return not re.search(r"<[^>]+>|\b(?:todo|tbd|fill this|placeholder)\b", value, re.IGNORECASE)


def _machine_only_reference(value: str) -> bool:
    targets = MARKDOWN_LINK.findall(value)
    machine_links = [
        target for target in targets
        if target.startswith(("project:", "rep:", "file:"))
        or target.split("#", 1)[0].split("?", 1)[0].lower().endswith(MACHINE_SUFFIXES)
    ]
    if not machine_links:
        return False
    residual = MARKDOWN_LINK.sub("", value)
    residual = re.sub(r"[`*_~\s.,;:()[\]{}\-–—→]+", "", residual)
    return not residual


def _human_links(value: str, report_path: Path, project_root: Path) -> list[str]:
    valid: list[str] = []
    for target in MARKDOWN_LINK.findall(value):
        target = target.strip()
        base = target.split("#", 1)[0].split("?", 1)[0]
        if target.startswith(("project:", "rep:", "file:")) or base.lower().endswith(MACHINE_SUFFIXES):
            continue
        if target.startswith(("http://", "https://")):
            valid.append(target)
            continue
        if not base or Path(base).is_absolute():
            continue
        resolved = (report_path.parent / base).resolve()
        try:
            resolved.relative_to(project_root)
        except ValueError:
            continue
        if resolved.is_file() and resolved.suffix.lower() in HUMAN_SUFFIXES:
            valid.append(target)
    return valid


def _metadata(text: str) -> dict[str, str] | None:
    block = _between(text, METADATA_START, METADATA_END)
    if block is None:
        return None
    return {
        "kind": _field(block, "Report kind").strip("`"),
        "id": _field(block, "Report ID").strip("`"),
        "created": _field(block, "Created").strip("`"),
        "supersedes": _field(block, "Supersedes report ID").strip("`"),
        "registry": _field(block, "Relation registry"),
    }


def _validate_metadata(text: str, row: RegistryRow, path: Path, root: Path, errors: list[dict[str, str]]) -> None:
    rel = path.relative_to(root).as_posix()
    meta = _metadata(visible_markdown(text, preserved_markers=STRUCTURAL_MARKERS))
    if meta is None:
        errors.append(_issue("missing_report_metadata", "report metadata markers are missing or duplicated", rel))
        return
    if meta["kind"] != "main_research_report" or meta["id"] != row.report_id or meta["supersedes"] != row.supersedes:
        errors.append(_issue("report_registry_metadata_mismatch", "report kind, ID, or supersedes metadata disagrees with the registry", rel))
    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", meta["created"]):
        errors.append(_issue("invalid_report_created_date", "Created must use YYYY-MM-DD", rel))
    links = MARKDOWN_LINK.findall(meta["registry"])
    if len(links) != 1 or not links[0].endswith("project_index.md#main-research-report") or not _human_links(meta["registry"], path, root):
        errors.append(_issue("missing_relation_registry_link", "every report must link back to the supersession registry", rel))


def _validation_blocks(section: str) -> list[str]:
    starts = list(re.finditer(r"^### Validation record:\s*.+$", section, re.MULTILINE))
    return [section[item.end(): starts[i + 1].start() if i + 1 < len(starts) else len(section)] for i, item in enumerate(starts)]


def _validate_validation(section: str, report_path: Path, root: Path, rel: str, errors: list[dict[str, str]]) -> None:
    blocks = _validation_blocks(section)
    independent = 0
    if not blocks:
        errors.append(_issue("missing_validation_record", "at least one structured validation record is required", rel))
    for block in blocks:
        values = {label: _field(block, label).strip("`") for label in VALIDATION_FIELDS}
        missing = [label for label, value in values.items() if not _filled(value)]
        if missing:
            errors.append(_issue("incomplete_validation_record", f"validation record has unfilled fields: {', '.join(missing)}", rel))
            continue
        classification = values["Classification"]
        relations = [values[name] for name in ("Implementation relation", "Input relation", "Environment relation")]
        if classification not in {"independent", "replay", "supporting_only"} or any(value not in {"same", "different", "not_applicable"} for value in relations):
            errors.append(_issue("invalid_validation_classification", "validation classification or relation vocabulary is invalid", rel))
            continue
        if not _human_links(values["Human-readable validation evidence"], report_path, root):
            errors.append(_issue("validation_evidence_not_human_readable", "validation evidence must use a reachable human-readable link", rel))
        if classification == "independent":
            independent += 1
            if relations[0] == "same" and relations[1] == "same":
                errors.append(_issue("same_implementation_replay_claimed_independent", "same implementation and same input is replay regardless of environment, not independent validation", rel))
        if classification == "replay":
            declared = {item.strip().lower() for item in values["Declared replay risks"].split(",")}
            if not declared or not declared <= REPLAY_RISKS:
                errors.append(_issue("replay_without_declared_risk", "replay risks must use the declared risk vocabulary", rel))
    if independent == 0:
        errors.append(_issue("missing_independent_validation", "the report must include genuinely independent validation evidence", rel))


def _validate_current_report(path: Path, root: Path, errors: list[dict[str, str]]) -> None:
    rel = path.relative_to(root).as_posix()
    text = path.read_text(encoding="utf-8", errors="replace")
    visible_text = visible_markdown(text, preserved_markers=STRUCTURAL_MARKERS)
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
            all_values = _field_values(visible_text, label)
            scoped_values = _field_values(section, label)
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
            if not _filled(value):
                errors.append(_issue("incomplete_report_field", f"required field is unfilled: {label}", rel))
            elif label not in {"Human-readable evidence chain", "Machine provenance"} and _machine_only_reference(value):
                errors.append(_issue("machine_provenance_substitutes_for_narrative", f"machine references cannot replace explanatory narrative: {label}", rel))
    evidence = _field(sections.get("EVIDENCE", ""), "Human-readable evidence chain")
    if evidence and not _human_links(evidence, path, root):
        errors.append(_issue("machine_provenance_substitutes_for_human_evidence", "the evidence chain needs a reachable human-readable link; machine references do not count", rel))
    _validate_validation(sections.get("VALIDATION", ""), path, root, rel, errors)


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
