"""Identity, artifact, and summary primitives for runtime-bound literature ledgers."""

from __future__ import annotations

import sys
import unicodedata
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "research-team" / "scripts" / "lib"))

from literature_coverage import validate_bounded_provider_accounting
from literature_identity import (
    CanonicalIdentity,
    canonicalize_stable_locator,
    normalize_title,
    normalize_year,
    resolve_pinned_project_json,
    validate_canonical_identity,
)


CANDIDATE_DISPOSITIONS = {
    "core",
    "supporting",
    "background",
    "duplicate",
    "out_of_scope",
    "coverage_debt",
}
METHOD_DISPOSITIONS = {"classified", "out_of_scope", "coverage_debt"}
SCREENING_DISPOSITIONS = {"method_bearing", "not_method_bearing", "coverage_debt"}


def text(value: object) -> str:
    return str(value or "").strip()


def fold(value: object) -> str:
    return normalize_title(value)


def year(value: object) -> str:
    return normalize_year(value)


def canonical_locator(value: object) -> str | None:
    return canonicalize_stable_locator(value)


def resolve_project_json(
    ref: object,
    project_root: Path,
    label: str,
    problems: list[str],
) -> dict[str, Any] | None:
    document, _ = resolve_pinned_project_json(ref, project_root, label, problems)
    return document


def canonical_identity(
    candidate: dict[str, Any],
    label: str,
    problems: list[str],
    project_root: Path,
) -> CanonicalIdentity | None:
    if text(candidate.get("identity_status")) != "resolved":
        if candidate.get("canonical_identity") is not None:
            problems.append(f"{label}.canonical_identity must be absent while identity_status='unresolved'")
        return None
    if "stable_ids" in candidate:
        problems.append(f"{label}.stable_ids is not canonical identity authority")
    return validate_canonical_identity(
        candidate.get("canonical_identity"),
        label,
        problems,
        project_root=project_root,
    )


def survey_core_records(
    survey: dict[str, Any],
    problems: list[str],
) -> list[tuple[set[str], str, str]]:
    records: list[tuple[set[str], str, str]] = []
    papers = survey.get("papers")
    if not isinstance(papers, list):
        return records
    for index, paper in enumerate(papers):
        if not isinstance(paper, dict) or paper.get("role") != "core":
            continue
        label = f"literature_survey_v1.papers[{index}]"
        identity = paper.get("identity_triangulation")
        providers = identity.get("providers") if isinstance(identity, dict) else None
        keys: set[str] = set()
        titles: set[str] = set()
        years: set[str] = set()
        if isinstance(providers, list):
            for record in providers:
                if not isinstance(record, dict):
                    continue
                provider = text(record.get("provider")).casefold()
                identifier = text(record.get("identifier"))
                direct = canonical_locator(identifier)
                if direct:
                    keys.add(direct)
                elif provider and identifier:
                    keys.add(f"provider:{provider}:{unicodedata.normalize('NFKC', identifier)}")
                doi = canonical_locator(record.get("doi"))
                if doi:
                    keys.add(doi)
                if fold(record.get("title")):
                    titles.add(fold(record.get("title")))
                if year(record.get("year")):
                    years.add(year(record.get("year")))
        links = paper.get("source_links")
        for link in links if isinstance(links, list) else []:
            key = canonical_locator(link)
            if key:
                keys.add(key)
        if not keys:
            problems.append(f"{label} has no canonical identity locator")
        if len(titles) != 1 or len(years) != 1:
            problems.append(f"{label} identity metadata is not internally consistent")
        records.append((keys, next(iter(titles), ""), next(iter(years), "")))
    return records


def compare_summary(
    actual: dict[str, Any],
    expected: dict[str, Any],
    label: str,
    problems: list[str],
) -> None:
    for field, expected_value in expected.items():
        if actual.get(field) != expected_value:
            problems.append(
                f"{label}.{field}={actual.get(field)!r} does not match detailed ledger value {expected_value!r}"
            )
