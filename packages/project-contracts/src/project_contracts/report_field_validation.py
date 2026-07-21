from __future__ import annotations

import re
from pathlib import Path

from .report_registry import MARKDOWN_LINK


VALIDATION_FIELDS = (
    "Classification", "Implementation relation", "Input relation", "Environment relation",
    "Method or representation difference", "Declared replay risks", "Validation result",
    "Human-readable validation evidence",
)
MACHINE_SUFFIXES = (".json", ".jsonl", ".yaml", ".yml", ".lock")
HUMAN_SUFFIXES = (".md", ".html", ".htm", ".pdf", ".txt")
REPLAY_RISKS = {"randomness", "parallelism", "cache", "external_state", "unfixed_dependencies"}


def field_values(text: str, label: str) -> list[str]:
    return [
        match.strip()
        for match in re.findall(rf"^- {re.escape(label)}:[ \t]*([^\r\n]*?)[ \t]*$", text, re.MULTILINE)
    ]


def first_field(text: str, label: str) -> str:
    values = field_values(text, label)
    return values[0] if values else ""


def field_is_filled(value: str) -> bool:
    plain = value.strip().strip("`").lower()
    if not plain or plain in {"none", "n/a", "not applicable", "(none yet)", "-"}:
        return False
    return not re.search(r"<[^>]+>|\b(?:todo|tbd|fill this|placeholder)\b", value, re.IGNORECASE)


def machine_only_reference(value: str) -> bool:
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


def human_links(value: str, report_path: Path, project_root: Path) -> list[str]:
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


def _validation_records(section: str) -> list[tuple[str, str]]:
    starts = list(re.finditer(r"^### Validation record:[ \t]*(.*?)[ \t]*$", section, re.MULTILINE))
    return [
        (
            item.group(1).strip().strip("`"),
            section[item.end(): starts[i + 1].start() if i + 1 < len(starts) else len(section)],
        )
        for i, item in enumerate(starts)
    ]


def _issue(code: str, message: str, path: str) -> dict[str, str]:
    return {"code": code, "path": path, "message": message}


def validate_validation_section(
    section: str,
    report_path: Path,
    root: Path,
    rel: str,
    errors: list[dict[str, str]],
) -> None:
    records = _validation_records(section)
    independent = 0
    if not records:
        errors.append(_issue("missing_validation_record", "at least one structured validation record is required", rel))
    record_ids = [record_id for record_id, _ in records]
    if any(not field_is_filled(record_id) for record_id in record_ids):
        errors.append(_issue("incomplete_validation_record_id", "every validation record ID must be filled", rel))
    duplicated_ids = sorted({record_id for record_id in record_ids if record_ids.count(record_id) > 1})
    if duplicated_ids:
        errors.append(_issue("validation_record_id_not_unique", f"validation record IDs must be unique: {', '.join(duplicated_ids)}", rel))
    for _, block in records:
        duplicated = [label for label in VALIDATION_FIELDS if len(field_values(block, label)) > 1]
        if duplicated:
            errors.append(_issue("validation_field_not_unique", f"validation fields must occur exactly once per record: {', '.join(duplicated)}", rel))
            continue
        values = {label: first_field(block, label).strip("`") for label in VALIDATION_FIELDS}
        missing = [label for label, value in values.items() if not field_is_filled(value)]
        if missing:
            errors.append(_issue("incomplete_validation_record", f"validation record has unfilled fields: {', '.join(missing)}", rel))
            continue
        classification = values["Classification"]
        relations = [values[name] for name in ("Implementation relation", "Input relation", "Environment relation")]
        if classification not in {"independent", "replay", "supporting_only"} or any(value not in {"same", "different", "not_applicable"} for value in relations):
            errors.append(_issue("invalid_validation_classification", "validation classification or relation vocabulary is invalid", rel))
            continue
        if not human_links(values["Human-readable validation evidence"], report_path, root):
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
