"""Candidate-ledger validation and bibliography-claim derivation."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any

from literature_ledger_primitives import (
    CANDIDATE_DISPOSITIONS,
    CanonicalIdentity,
    canonical_identity,
    text,
)


@dataclass
class CandidateContext:
    selected_ids: list[str]
    candidates_by_id: dict[str, dict[str, Any]]
    identities: dict[str, CanonicalIdentity]
    ledger_core_ids: set[str]
    debt_candidate_ids: list[str]
    bibliography_claims: dict[str, set[tuple[str, str]]]


def validate_candidate_pool(
    ledger: dict[str, Any],
    ledger_status: str,
    project_root: Path,
    problems: list[str],
) -> CandidateContext | None:
    pool = ledger.get("candidate_pool")
    if not isinstance(pool, dict):
        problems.append("detailed ledger candidate_pool must be an object")
        return None
    selected = pool.get("selected_core_ids")
    candidates = pool.get("candidates")
    if not isinstance(selected, list) or not all(text(item) for item in selected):
        problems.append("detailed ledger candidate_pool.selected_core_ids must be a non-empty string array")
        selected = []
    selected_ids = [text(item) for item in selected]
    if len(selected_ids) != len(set(selected_ids)):
        problems.append("detailed ledger selected_core_ids must not contain duplicates")
    if not isinstance(candidates, list):
        problems.append("detailed ledger candidate_pool.candidates must be an array")
        candidates = []
    total = pool.get("total_candidates")
    if isinstance(total, bool) or not isinstance(total, int) or total < 0:
        problems.append("detailed ledger candidate_pool.total_candidates must be a non-negative integer")
    elif total != len(candidates):
        problems.append("detailed ledger candidate_pool.total_candidates must equal the explicit candidate ledger")
    if not text(pool.get("artifact")):
        problems.append("detailed ledger candidate_pool.artifact is required")
    if not text(pool.get("selection_rationale")):
        problems.append("detailed ledger candidate_pool.selection_rationale is required")

    by_id: dict[str, dict[str, Any]] = {}
    identities: dict[str, CanonicalIdentity] = {}
    key_owners: dict[str, str] = {}
    claims = {source_id: set() for source_id in selected_ids}
    selected_set = set(selected_ids)
    for index, candidate in enumerate(candidates):
        label = f"detailed ledger candidate_pool.candidates[{index}]"
        if not isinstance(candidate, dict):
            problems.append(f"{label} must be an object")
            continue
        candidate_id = text(candidate.get("id"))
        if not candidate_id or candidate_id in by_id:
            problems.append(f"{label}.id is missing or duplicated")
            continue
        by_id[candidate_id] = candidate
        status = text(candidate.get("identity_status"))
        if status not in {"resolved", "unresolved"}:
            problems.append(f"{label}.identity_status must be resolved or unresolved")
        identity = canonical_identity(candidate, label, problems, project_root)
        if identity:
            identities[candidate_id] = identity
            for key in identity.keys:
                owner = key_owners.get(key)
                if owner is not None:
                    problems.append(
                        f"{label} canonical identity {key!r} is already occupied by {owner!r}; merge aliases"
                    )
                else:
                    key_owners[key] = candidate_id
        disposition = text(candidate.get("disposition"))
        if disposition not in CANDIDATE_DISPOSITIONS:
            problems.append(f"{label}.disposition is invalid")
        if status == "unresolved" and disposition != "coverage_debt":
            problems.append(f"{label}: unresolved identity must remain coverage_debt")
        if not text(candidate.get("rationale")):
            problems.append(f"{label}.rationale is required")
        discoveries = candidate.get("discovered_from")
        if not isinstance(discoveries, list) or not discoveries:
            problems.append(f"{label}.discovered_from must record at least one discovery source")
            continue
        for discovery_index, discovery in enumerate(discoveries):
            discovery_label = f"{label}.discovered_from[{discovery_index}]"
            if not isinstance(discovery, dict):
                problems.append(f"{discovery_label} must be an object")
                continue
            kind = text(discovery.get("kind"))
            source_id = text(discovery.get("source_id"))
            locator = text(discovery.get("locator"))
            if kind not in {"search", "bibliography", "citation"} or not source_id or not locator:
                problems.append(f"{discovery_label} requires kind, source_id, and locator")
                continue
            if kind == "bibliography":
                if source_id not in selected_set:
                    problems.append(
                        f"{discovery_label}.source_id {source_id!r} is not a selected core source"
                    )
                    continue
                claim = (candidate_id, locator)
                if claim in claims[source_id]:
                    problems.append(f"{discovery_label} duplicates a bibliography candidate/locator claim")
                claims[source_id].add(claim)

    for selected_id in selected_ids:
        if text(by_id.get(selected_id, {}).get("disposition")) != "core":
            problems.append(f"detailed ledger selected core candidate {selected_id!r} must have disposition='core'")
    ledger_core_ids = {cid for cid, record in by_id.items() if text(record.get("disposition")) == "core"}
    if ledger_core_ids != selected_set:
        problems.append("detailed ledger contains core-disposition candidate(s) absent from selected_core_ids")
    debt_ids = sorted(
        cid
        for cid, record in by_id.items()
        if text(record.get("identity_status")) == "unresolved"
        or text(record.get("disposition")) == "coverage_debt"
    )
    if ledger_status == "saturated" and debt_ids:
        problems.append(
            "detailed ledger final_status=saturated cannot retain unresolved/coverage-debt candidates: "
            + ", ".join(debt_ids)
        )
    return CandidateContext(selected_ids, by_id, identities, ledger_core_ids, debt_ids, claims)
