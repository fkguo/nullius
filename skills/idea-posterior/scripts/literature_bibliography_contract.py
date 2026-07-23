"""Bidirectional closure for candidate claims and pinned bibliography manifests."""

from __future__ import annotations

from pathlib import Path
from typing import Any

from literature_candidate_contract import CandidateContext
from literature_ledger_primitives import CANDIDATE_DISPOSITIONS, canonical_locator, fold, resolve_project_json, text, year


def validate_bibliography(
    ledger: dict[str, Any],
    context: CandidateContext,
    project_root: Path,
    problems: list[str],
) -> tuple[dict[str, set[str]], dict[str, Any]]:
    start_errors = len(problems)
    bibliography = ledger.get("bibliography_reconciliation")
    sources = bibliography.get("core_sources") if isinstance(bibliography, dict) else None
    if not isinstance(sources, list):
        problems.append("detailed ledger bibliography_reconciliation.core_sources must be an array")
        sources = []
    statuses: dict[str, str] = {}
    candidates_by_source: dict[str, set[str]] = {}
    for index, source in enumerate(sources):
        label = f"detailed ledger bibliography_reconciliation.core_sources[{index}]"
        if not isinstance(source, dict):
            problems.append(f"{label} must be an object")
            continue
        source_id = text(source.get("id"))
        if not source_id or source_id in statuses:
            problems.append(f"{label}.id is missing or duplicated")
            continue
        status = text(source.get("status"))
        statuses[source_id] = status
        if status not in {"reconciled", "coverage_debt"}:
            problems.append(f"{label}.status is invalid")
        candidate_ids = source.get("candidate_ids")
        if not isinstance(candidate_ids, list) or not all(text(item) for item in candidate_ids):
            problems.append(f"{label}.candidate_ids must be an array of strings")
            candidate_ids = []
        candidate_set = {text(item) for item in candidate_ids}
        if len(candidate_set) != len(candidate_ids):
            problems.append(f"{label}.candidate_ids must not contain duplicates")
        claims = context.bibliography_claims.get(source_id, set())
        claimed_candidate_ids = {candidate_id for candidate_id, _ in claims}
        candidates_by_source[source_id] = claimed_candidate_ids
        if candidate_set != claimed_candidate_ids:
            problems.append(f"{label}.candidate_ids do not match the candidate bibliography discovery claims")
        unknown = sorted(candidate_set - context.candidates_by_id.keys())
        if unknown:
            problems.append(f"{label}.candidate_ids references unknown candidates: {', '.join(unknown)}")

        manifest = resolve_project_json(
            source.get("references_artifact_ref"),
            project_root,
            f"{label}.references_artifact_ref",
            problems,
        )
        manifest_claims: set[tuple[str, str]] = set()
        references: list[Any] = []
        if manifest is not None:
            if text(manifest.get("source_id")) != source_id:
                problems.append(f"{label}.references_artifact_ref source_id mismatch")
            raw_references = manifest.get("references")
            if not isinstance(raw_references, list):
                problems.append(f"{label}.references_artifact_ref.references must be an array")
            else:
                references = raw_references
        extracted = source.get("references_extracted")
        if isinstance(extracted, bool) or not isinstance(extracted, int) or extracted < 0:
            problems.append(f"{label}.references_extracted must be a non-negative integer")
        elif extracted != len(references):
            problems.append(f"{label}.references_extracted does not match raw bibliography count")
        for reference_index, reference in enumerate(references):
            reference_label = f"{label}.references_artifact_ref.references[{reference_index}]"
            if not isinstance(reference, dict):
                problems.append(f"{reference_label} must be an object")
                continue
            candidate_id = text(reference.get("candidate_id"))
            locator = text(reference.get("locator"))
            if not text(reference.get("raw_text")) or not locator:
                problems.append(f"{reference_label} requires raw_text and locator")
            claim = (candidate_id, locator)
            if claim in manifest_claims:
                problems.append(f"{reference_label} duplicates a candidate_id/locator manifest entry")
            manifest_claims.add(claim)
            if candidate_id not in candidate_set:
                problems.append(f"{reference_label}.candidate_id is not reconciled by this source")
                continue
            candidate = context.candidates_by_id.get(candidate_id, {})
            identity = context.identities.get(candidate_id)
            if candidate.get("identity_status") == "resolved":
                raw_identity = reference.get("identity")
                if not isinstance(raw_identity, dict) or identity is None:
                    problems.append(f"{reference_label}.identity must bind the raw entry to its canonical candidate")
                else:
                    if canonical_locator(raw_identity.get("canonical_id")) not in identity.keys:
                        problems.append(f"{reference_label}.identity canonical_id mismatch")
                    if fold(raw_identity.get("title")) != identity.title:
                        problems.append(f"{reference_label}.identity title mismatch")
                    if year(raw_identity.get("year")) != identity.year:
                        problems.append(f"{reference_label}.identity year mismatch")
            elif text(reference.get("identity_status")) != "unresolved" or not text(reference.get("unresolved_reason")):
                problems.append(f"{reference_label} must preserve unresolved identity coverage debt")
        if manifest_claims != claims:
            problems.append(f"{label}: bibliography discovery claims do not match the pinned raw manifest")
        debt = source.get("coverage_debt")
        if not isinstance(debt, list):
            problems.append(f"{label}.coverage_debt must be an array")
            debt = []
        if status == "reconciled" and debt:
            problems.append(f"{label} cannot be reconciled while retaining coverage debt")

    selected_set = set(context.selected_ids)
    if set(statuses) != selected_set:
        problems.append("detailed ledger bibliography core set differs from selected_core_ids")
    records = list(context.candidates_by_id.values())
    complete = len(problems) == start_errors
    expected = {
        "status": "reconciled" if (
            complete
            and set(statuses) == selected_set
            and all(status == "reconciled" for status in statuses.values())
            and all(record.get("identity_status") == "resolved" for record in records)
            and all(text(record.get("disposition")) != "coverage_debt" for record in records)
            and context.ledger_core_ids == selected_set
        ) else "coverage_debt",
        "core_sources_total": len(context.selected_ids),
        "core_sources_reconciled": sum(status == "reconciled" for status in statuses.values()),
        "candidates_total": len(context.candidates_by_id),
        "candidates_dispositioned": sum(
            text(record.get("disposition")) in CANDIDATE_DISPOSITIONS for record in records
        ),
        "unresolved_candidates": sum(record.get("identity_status") == "unresolved" for record in records),
        "coverage_debt_candidates": sum(text(record.get("disposition")) == "coverage_debt" for record in records),
    }
    return candidates_by_source, expected
