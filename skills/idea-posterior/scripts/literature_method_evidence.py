"""Source-text method evidence validation."""

from __future__ import annotations

from literature_ledger_primitives import METHOD_DISPOSITIONS, text


def validate_method_description(
    item: object,
    *,
    label: str,
    families: set[str],
    disposition_field: str,
    problems: list[str],
) -> tuple[bool, bool]:
    if not isinstance(item, dict):
        problems.append(f"{label} must be an object")
        return False, True
    description = text(item.get("description"))
    evidence_basis = text(item.get("evidence_basis"))
    features = item.get("method_features")
    family_ids = item.get("family_ids")
    disposition = text(item.get(disposition_field))
    valid = True
    if not description:
        problems.append(f"{label}.description is required")
        valid = False
    if not text(item.get("locator")):
        problems.append(f"{label}.locator is required")
        valid = False
    if evidence_basis != "source_text":
        problems.append(f"{label}.evidence_basis must be 'source_text'")
        valid = False
    if not isinstance(features, list) or not features or not all(text(feature) for feature in features):
        problems.append(f"{label}.method_features must be a non-empty string array")
        valid = False
    elif description and not any(text(feature).casefold() in description.casefold() for feature in features):
        problems.append(f"{label}.description must contain a recorded method feature")
        valid = False
    if not isinstance(family_ids, list):
        problems.append(f"{label}.family_ids must be an array")
        family_ids = []
        valid = False
    unknown = sorted({text(family) for family in family_ids if text(family)} - families)
    if unknown:
        problems.append(f"{label}.family_ids contains unknown taxonomy families: {', '.join(unknown)}")
        valid = False
    if disposition not in METHOD_DISPOSITIONS:
        problems.append(f"{label}.{disposition_field} must be one of {sorted(METHOD_DISPOSITIONS)}")
        valid = False
    if disposition == "classified" and not family_ids:
        problems.append(f"{label}: classified requires at least one taxonomy family")
        valid = False
    if disposition != "classified" and family_ids:
        problems.append(f"{label}: only classified may carry family_ids")
        valid = False
    return valid, disposition == "coverage_debt"
