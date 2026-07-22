#!/usr/bin/env python3
"""
Literature discovery saturation gate (domain-neutral).

Purpose:
- Ensure literature/reference/knowledge-evidence work has an auditable discovery trace,
  provider coverage record, candidate pool, and citation/reference graph checks.
- A few Markdown query rows or a small fixed paper count are not sufficient to declare
  literature research complete.

Default paths (relative to project root):
  knowledge_base/methodology_traces/literature_queries.md
  knowledge_base/methodology_traces/literature_saturation.json

Config:
- features.literature_trace_gate: enable/disable this gate (default: True).
- Optional overrides:
    references.trace_log_path: "knowledge_base/methodology_traces/literature_queries.md"
    references.saturation_path: "knowledge_base/methodology_traces/literature_saturation.json"

Exit codes:
  0  ok, gate disabled, or no literature-bearing gates are active
  1  missing/incomplete trace or saturation artifact
  2  input/config error
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from dataclasses import dataclass
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "lib"))

from team_config import load_team_config  # type: ignore
from literature_identity import (  # type: ignore
    CanonicalIdentity,
    canonicalize_stable_locator,
    normalize_title,
    normalize_year,
    resolve_pinned_project_json,
    validate_canonical_identity,
)
from literature_coverage import validate_bounded_provider_accounting  # type: ignore


DEFAULT_TRACE = "knowledge_base/methodology_traces/literature_queries.md"
DEFAULT_SATURATION = "knowledge_base/methodology_traces/literature_saturation.json"
_ISO_TS = re.compile(r"^(19|20)\d{2}-\d{2}-\d{2}T")
_FINAL_STATUSES = {"saturated", "coverage_incomplete"}
_COVERAGE_STATUSES = {"saturated", "coverage_incomplete", "not_covered", "unavailable"}
_CANDIDATE_IDENTITY_STATUSES = {"resolved", "unresolved"}
_CANDIDATE_DISPOSITIONS = {
    "core",
    "supporting",
    "background",
    "duplicate",
    "out_of_scope",
    "coverage_debt",
}
_DISCOVERY_KINDS = {"search", "bibliography", "citation"}
_RECONCILIATION_STATUSES = {"reconciled", "coverage_debt"}
_METHOD_AUDIT_STATUSES = {"audited", "coverage_debt"}
_METHOD_DISPOSITIONS = {"classified", "out_of_scope", "coverage_debt"}
_METHOD_SCREENING_DISPOSITIONS = {"method_bearing", "not_method_bearing", "coverage_debt"}


@dataclass(frozen=True)
class Row:
    path: Path
    line: int
    text: str


def _trace_path_from_config(cfg: object) -> str:
    data = getattr(cfg, "data", None)
    if not isinstance(data, dict):
        return DEFAULT_TRACE
    refs = data.get("references", {})
    if isinstance(refs, dict):
        p = str(refs.get("trace_log_path") or "").strip()
        if p:
            return p
    return DEFAULT_TRACE


def _saturation_path_from_config(cfg: object) -> str:
    data = getattr(cfg, "data", None)
    if not isinstance(data, dict):
        return DEFAULT_SATURATION
    refs = data.get("references", {})
    if isinstance(refs, dict):
        p = str(refs.get("saturation_path") or "").strip()
        if p:
            return p
    return DEFAULT_SATURATION


def _project_stage(cfg: object) -> str:
    data = getattr(cfg, "data", None)
    if not isinstance(data, dict):
        return "development"
    return str(data.get("project_stage") or "development").strip() or "development"


def _gate_is_applicable(cfg: object) -> bool:
    data = getattr(cfg, "data", None)
    if not isinstance(data, dict):
        return True
    feats = data.get("features", {})
    if not isinstance(feats, dict):
        return True
    return bool(feats.get("references_gate")) or bool(feats.get("knowledge_layers_gate"))


def _require_reading_evidence(cfg: object) -> bool:
    data = getattr(cfg, "data", None)
    if not isinstance(data, dict):
        return False
    kb = data.get("knowledge_layers", {})
    return isinstance(kb, dict) and bool(kb.get("require_literature_reading_evidence", False))


def _resolve_project_path(project_root: Path, rel: str) -> Path:
    p = Path(rel.replace("\\\\", "/").lstrip("./"))
    if p.is_absolute():
        return p
    return project_root / p


def _as_dict(value: object, label: str, errors: list[str]) -> dict:
    if isinstance(value, dict):
        return value
    errors.append(f"{label}: expected object")
    return {}


def _as_list(value: object, label: str, errors: list[str]) -> list:
    if isinstance(value, list):
        return value
    errors.append(f"{label}: expected array")
    return []


def _nonempty_string(value: object) -> bool:
    return isinstance(value, str) and bool(value.strip())


def _int_or_none(value: object) -> int | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value
    return None


def _validate_candidate_ledger(
    candidate_pool: dict,
    project_root: Path,
    errors: list[str],
) -> tuple[dict[str, dict], dict[str, CanonicalIdentity]]:
    records = _as_list(candidate_pool.get("candidates"), "candidate_pool.candidates", errors)
    by_id: dict[str, dict] = {}
    identities_by_id: dict[str, CanonicalIdentity] = {}
    canonical_key_owners: dict[str, str] = {}
    for i, raw_record in enumerate(records):
        label = f"candidate_pool.candidates[{i}]"
        record = _as_dict(raw_record, label, errors)
        candidate_id = str(record.get("id") or "").strip()
        if not candidate_id:
            errors.append(f"{label}.id is required")
            continue
        if candidate_id in by_id:
            errors.append(f"{label}.id duplicates candidate {candidate_id!r}")
            continue
        by_id[candidate_id] = record

        identity_status = str(record.get("identity_status") or "").strip()
        if identity_status not in _CANDIDATE_IDENTITY_STATUSES:
            errors.append(f"{label}.identity_status must be one of {sorted(_CANDIDATE_IDENTITY_STATUSES)}")
        if "stable_ids" in record:
            errors.append(
                f"{label}.stable_ids is not identity authority; use canonical_identity with metadata provenance"
            )
        identity: CanonicalIdentity | None = None
        if identity_status == "resolved":
            identity = validate_canonical_identity(
                record.get("canonical_identity"),
                label,
                errors,
                project_root=project_root,
            )
        elif record.get("canonical_identity") is not None:
            errors.append(f"{label}.canonical_identity must be absent while identity_status='unresolved'")
        if identity is not None:
            identities_by_id[candidate_id] = identity
        for canonical_key in sorted(identity.keys if identity else []):
            owner = canonical_key_owners.get(canonical_key)
            if owner is not None:
                errors.append(
                    f"{label}.canonical_identity repeats canonical identity {canonical_key!r} "
                    f"from candidate {owner!r}; "
                    "merge aliases into one normalized candidate record"
                )
            else:
                canonical_key_owners[canonical_key] = candidate_id

        disposition = str(record.get("disposition") or "").strip()
        if disposition not in _CANDIDATE_DISPOSITIONS:
            errors.append(f"{label}.disposition must be one of {sorted(_CANDIDATE_DISPOSITIONS)}")
        if identity_status == "unresolved" and disposition != "coverage_debt":
            errors.append(f"{label}: unresolved identity must remain disposition='coverage_debt'")
        if not _nonempty_string(record.get("rationale")):
            errors.append(f"{label}.rationale is required")

        discovered_from = _as_list(record.get("discovered_from"), f"{label}.discovered_from", errors)
        if not discovered_from:
            errors.append(f"{label}.discovered_from must record at least one discovery source")
        for j, raw_source in enumerate(discovered_from):
            source_label = f"{label}.discovered_from[{j}]"
            source = _as_dict(raw_source, source_label, errors)
            if str(source.get("kind") or "").strip() not in _DISCOVERY_KINDS:
                errors.append(f"{source_label}.kind must be one of {sorted(_DISCOVERY_KINDS)}")
            if not _nonempty_string(source.get("source_id")):
                errors.append(f"{source_label}.source_id is required")
            if not _nonempty_string(source.get("locator")):
                errors.append(f"{source_label}.locator is required")
    return by_id, identities_by_id


def _validate_bibliography_reconciliation(
    value: object,
    *,
    project_root: Path,
    selected_core_ids: list[str],
    candidates_by_id: dict[str, dict],
    identities_by_id: dict[str, CanonicalIdentity],
    final_status: str,
    errors: list[str],
) -> dict[str, set[str]]:
    reconciliation = _as_dict(value, "bibliography_reconciliation", errors)
    core_sources = _as_list(reconciliation.get("core_sources"), "bibliography_reconciliation.core_sources", errors)
    candidates_by_source: dict[str, set[str]] = {}
    statuses: dict[str, str] = {}
    for i, raw_source in enumerate(core_sources):
        label = f"bibliography_reconciliation.core_sources[{i}]"
        source = _as_dict(raw_source, label, errors)
        source_id = str(source.get("id") or "").strip()
        if not source_id:
            errors.append(f"{label}.id is required")
            continue
        if source_id in statuses:
            errors.append(f"{label}.id duplicates core source {source_id!r}")
            continue
        status = str(source.get("status") or "").strip()
        statuses[source_id] = status
        if status not in _RECONCILIATION_STATUSES:
            errors.append(f"{label}.status must be one of {sorted(_RECONCILIATION_STATUSES)}")
        artifact_references: list | None = None
        if "references_artifact" in source:
            errors.append(
                f"{label}.references_artifact is unpinned; use references_artifact_ref with an exact SHA-256 pin"
            )
        artifact_data, _ = resolve_pinned_project_json(
            source.get("references_artifact_ref"),
            project_root,
            f"{label}.references_artifact_ref",
            errors,
        )
        if artifact_data is not None:
            artifact = _as_dict(artifact_data, f"{label}.references_artifact_ref", errors)
            if str(artifact.get("source_id") or "").strip() != source_id:
                errors.append(f"{label}.references_artifact_ref.source_id must equal {source_id!r}")
            artifact_references = _as_list(
                artifact.get("references"),
                f"{label}.references_artifact_ref.references",
                errors,
            )
        extracted = _int_or_none(source.get("references_extracted"))
        if extracted is None or extracted < 0:
            errors.append(f"{label}.references_extracted must be a non-negative integer")
        candidate_ids = [
            str(item).strip()
            for item in _as_list(source.get("candidate_ids"), f"{label}.candidate_ids", errors)
            if str(item).strip()
        ]
        if len(candidate_ids) != len(set(candidate_ids)):
            errors.append(f"{label}.candidate_ids must not contain duplicates")
        if artifact_references is not None and extracted is not None and extracted != len(artifact_references):
            errors.append(f"{label}.references_extracted must equal the raw references manifest count")
        candidates_by_source[source_id] = set(candidate_ids)
        debt = [
            str(item).strip()
            for item in _as_list(source.get("coverage_debt"), f"{label}.coverage_debt", errors)
            if str(item).strip()
        ]
        if status == "reconciled" and debt:
            errors.append(f"{label}: status='reconciled' cannot retain coverage_debt")
        if status == "coverage_debt" and not debt:
            errors.append(f"{label}: status='coverage_debt' must explain the remaining debt")
        mapped_candidate_ids: set[str] = set()
        if artifact_references is not None:
            for j, raw_reference in enumerate(artifact_references):
                reference_label = f"{label}.references_artifact_ref.references[{j}]"
                reference = _as_dict(raw_reference, reference_label, errors)
                raw_text = reference.get("raw_text")
                locator = str(reference.get("locator") or "").strip()
                candidate_id = str(reference.get("candidate_id") or "").strip()
                if not _nonempty_string(raw_text):
                    errors.append(f"{reference_label}.raw_text is required")
                if not locator:
                    errors.append(f"{reference_label}.locator is required")
                if not candidate_id:
                    errors.append(f"{reference_label}.candidate_id is required")
                    continue
                mapped_candidate_ids.add(candidate_id)
                if candidate_id not in set(candidate_ids):
                    errors.append(f"{reference_label}.candidate_id is absent from {label}.candidate_ids")
                    continue
                candidate = candidates_by_id.get(candidate_id)
                sources = candidate.get("discovered_from") if isinstance(candidate, dict) else None
                linked = any(
                    isinstance(item, dict)
                    and str(item.get("kind") or "").strip() == "bibliography"
                    and str(item.get("source_id") or "").strip() == source_id
                    and str(item.get("locator") or "").strip() == locator
                    for item in (sources if isinstance(sources, list) else [])
                )
                if not linked:
                    errors.append(
                        f"{reference_label} is not linked to the candidate ledger by source_id and locator"
                    )
                identity_status = str(candidate.get("identity_status") or "").strip() if isinstance(candidate, dict) else ""
                raw_identity = reference.get("identity")
                if identity_status == "resolved":
                    if not isinstance(raw_identity, dict):
                        errors.append(
                            f"{reference_label}.identity must bind the raw entry to the canonical candidate identity"
                        )
                    else:
                        raw_key = canonicalize_stable_locator(raw_identity.get("canonical_id"))
                        candidate_identity = identities_by_id.get(candidate_id)
                        if candidate_identity is None or raw_key not in candidate_identity.keys:
                            errors.append(
                                f"{reference_label}.identity.canonical_id does not match the canonical candidate identity"
                            )
                        if candidate_identity is not None:
                            if normalize_title(raw_identity.get("title")) != candidate_identity.title:
                                errors.append(
                                    f"{reference_label}.identity.title does not match canonical candidate metadata"
                                )
                            if normalize_year(raw_identity.get("year")) != candidate_identity.year:
                                errors.append(
                                    f"{reference_label}.identity.year does not match canonical candidate metadata"
                                )
                else:
                    if raw_identity is not None:
                        errors.append(f"{reference_label}.identity must be absent for an unresolved candidate")
                    if str(reference.get("identity_status") or "").strip() != "unresolved":
                        errors.append(f"{reference_label}.identity_status must be 'unresolved'")
                    if not _nonempty_string(reference.get("unresolved_reason")):
                        errors.append(f"{reference_label}.unresolved_reason is required")
            if mapped_candidate_ids != set(candidate_ids):
                missing_mappings = sorted(set(candidate_ids) - mapped_candidate_ids)
                if missing_mappings:
                    errors.append(
                        f"{label}.references_artifact has no raw-reference mapping for candidate(s): "
                        + ", ".join(missing_mappings)
                    )
        for candidate_id in candidate_ids:
            candidate = candidates_by_id.get(candidate_id)
            if candidate is None:
                errors.append(f"{label}.candidate_ids references unknown candidate {candidate_id!r}")
                continue
            sources = candidate.get("discovered_from") if isinstance(candidate, dict) else None
            has_bibliography_source = any(
                isinstance(item, dict)
                and str(item.get("kind") or "").strip() == "bibliography"
                and str(item.get("source_id") or "").strip() == source_id
                and _nonempty_string(item.get("locator"))
                for item in (sources if isinstance(sources, list) else [])
            )
            if not has_bibliography_source:
                errors.append(
                    f"candidate_pool candidate {candidate_id!r} lacks a bibliography discovery locator for core source {source_id!r}"
                )

    if set(statuses) != set(selected_core_ids):
        missing = sorted(set(selected_core_ids) - set(statuses))
        extra = sorted(set(statuses) - set(selected_core_ids))
        if missing:
            errors.append("bibliography_reconciliation missing selected core source(s): " + ", ".join(missing))
        if extra:
            errors.append("bibliography_reconciliation contains non-core source(s): " + ", ".join(extra))
    if final_status == "saturated":
        unreconciled = sorted(source_id for source_id, status in statuses.items() if status != "reconciled")
        if unreconciled:
            errors.append("final_status=saturated requires reconciled bibliographies for: " + ", ".join(unreconciled))
    return candidates_by_source


def _validate_method_description(
    raw_item: object,
    *,
    label: str,
    families: set[str],
    candidates_by_id: dict[str, dict],
    source_candidate_ids: set[str],
    cited: bool,
    errors: list[str],
) -> str:
    item = _as_dict(raw_item, label, errors)
    description = str(item.get("description") or "").strip()
    if not description:
        errors.append(f"{label}.description is required and must describe the method, not only title/year metadata")
    if not _nonempty_string(item.get("locator")):
        errors.append(f"{label}.locator is required")
    if str(item.get("evidence_basis") or "").strip() != "source_text":
        errors.append(f"{label}.evidence_basis must be 'source_text'; title/year metadata alone is insufficient")
    method_features = [
        str(value).strip()
        for value in _as_list(item.get("method_features"), f"{label}.method_features", errors)
        if str(value).strip()
    ]
    if not method_features:
        errors.append(f"{label}.method_features must record at least one source-grounded method characteristic")
    elif description and not any(feature.casefold() in description.casefold() for feature in method_features):
        errors.append(f"{label}.description must contain at least one recorded method feature; title/year metadata alone is insufficient")
    disposition = str(item.get("disposition") or "").strip()
    if disposition not in _METHOD_DISPOSITIONS:
        errors.append(f"{label}.disposition must be one of {sorted(_METHOD_DISPOSITIONS)}")
    family_ids = [
        str(value).strip()
        for value in _as_list(item.get("family_ids"), f"{label}.family_ids", errors)
        if str(value).strip()
    ]
    unknown_families = sorted(set(family_ids) - families)
    if unknown_families:
        errors.append(f"{label}.family_ids contains unknown taxonomy family(s): {', '.join(unknown_families)}")
    if disposition == "classified" and not family_ids:
        errors.append(f"{label}: disposition='classified' requires at least one taxonomy family")
    if disposition != "classified" and family_ids:
        errors.append(f"{label}: only disposition='classified' may carry family_ids")
    if cited:
        candidate_id = str(item.get("candidate_id") or "").strip()
        if not candidate_id:
            errors.append(f"{label}.candidate_id is required for a cited method description")
        elif candidate_id not in candidates_by_id:
            errors.append(f"{label}.candidate_id references unknown candidate {candidate_id!r}")
        elif candidate_id not in source_candidate_ids:
            errors.append(f"{label}.candidate_id is not reconciled from this core source bibliography")
    return disposition


def _validate_method_screening(
    raw_item: object,
    *,
    label: str,
    families: set[str],
    candidates_by_id: dict[str, dict],
    source_candidate_ids: set[str],
    errors: list[str],
) -> tuple[str, str]:
    item = _as_dict(raw_item, label, errors)
    candidate_id = str(item.get("candidate_id") or "").strip()
    if not candidate_id:
        errors.append(f"{label}.candidate_id is required")
    elif candidate_id not in candidates_by_id:
        errors.append(f"{label}.candidate_id references unknown candidate {candidate_id!r}")
    elif candidate_id not in source_candidate_ids:
        errors.append(f"{label}.candidate_id is not reconciled from this core source bibliography")
    disposition = str(item.get("disposition") or "").strip()
    if disposition not in _METHOD_SCREENING_DISPOSITIONS:
        errors.append(f"{label}.disposition must be one of {sorted(_METHOD_SCREENING_DISPOSITIONS)}")
    if not _nonempty_string(item.get("locator")):
        errors.append(f"{label}.locator is required")
    if not _nonempty_string(item.get("evidence_basis")):
        errors.append(f"{label}.evidence_basis is required")
    if not _nonempty_string(item.get("rationale")):
        errors.append(f"{label}.rationale is required")
    if disposition == "method_bearing":
        method_item = dict(item)
        method_item["disposition"] = item.get("method_disposition")
        _validate_method_description(
            method_item,
            label=label,
            families=families,
            candidates_by_id=candidates_by_id,
            source_candidate_ids=source_candidate_ids,
            cited=True,
            errors=errors,
        )
    elif disposition == "not_method_bearing" and str(item.get("evidence_basis") or "").strip() != "source_text":
        errors.append(
            f"{label}.evidence_basis must be 'source_text' for not_method_bearing; "
            "title/year metadata alone is insufficient"
        )
    elif any(
        field in item
        for field in ("description", "method_features", "family_ids", "method_disposition")
    ):
        errors.append(f"{label}: only disposition='method_bearing' may carry method classification fields")
    return candidate_id, disposition


def _validate_method_family_audit(
    value: object,
    *,
    selected_core_ids: list[str],
    candidates_by_id: dict[str, dict],
    bibliography_candidates: dict[str, set[str]],
    final_status: str,
    errors: list[str],
) -> None:
    audit = _as_dict(value, "method_family_audit", errors)
    status = str(audit.get("status") or "").strip()
    if status not in _METHOD_AUDIT_STATUSES:
        errors.append(f"method_family_audit.status must be one of {sorted(_METHOD_AUDIT_STATUSES)}")
    taxonomy = _as_list(audit.get("taxonomy"), "method_family_audit.taxonomy", errors)
    families: set[str] = set()
    for i, raw_family in enumerate(taxonomy):
        label = f"method_family_audit.taxonomy[{i}]"
        family = _as_dict(raw_family, label, errors)
        family_id = str(family.get("id") or "").strip()
        if not family_id:
            errors.append(f"{label}.id is required")
        elif family_id in families:
            errors.append(f"{label}.id duplicates taxonomy family {family_id!r}")
        else:
            families.add(family_id)
        if not _nonempty_string(family.get("label")):
            errors.append(f"{label}.label is required")
        if not _nonempty_string(family.get("description")):
            errors.append(f"{label}.description is required")
    if selected_core_ids and not families:
        errors.append("method_family_audit.taxonomy must contain at least one method family")

    source_audits = _as_list(audit.get("source_audits"), "method_family_audit.source_audits", errors)
    audited_ids: set[str] = set()
    unresolved = status != "audited"
    for i, raw_source in enumerate(source_audits):
        label = f"method_family_audit.source_audits[{i}]"
        source = _as_dict(raw_source, label, errors)
        source_id = str(source.get("source_id") or "").strip()
        if not source_id:
            errors.append(f"{label}.source_id is required")
            continue
        if source_id in audited_ids:
            errors.append(f"{label}.source_id duplicates core source {source_id!r}")
            continue
        audited_ids.add(source_id)
        paper_methods = _as_list(source.get("paper_method_descriptions"), f"{label}.paper_method_descriptions", errors)
        if not paper_methods:
            errors.append(f"{label}.paper_method_descriptions must contain source-local method evidence")
        for j, item in enumerate(paper_methods):
            disposition = _validate_method_description(
                item,
                label=f"{label}.paper_method_descriptions[{j}]",
                families=families,
                candidates_by_id=candidates_by_id,
                source_candidate_ids=bibliography_candidates.get(source_id, set()),
                cited=False,
                errors=errors,
            )
            unresolved = unresolved or disposition == "coverage_debt"
        if "cited_method_descriptions" in source:
            errors.append(
                f"{label}.cited_method_descriptions is not a complete screening ledger; "
                "use bibliography_candidate_screening"
            )
        if "cited_method_scan_complete" in source:
            errors.append(
                f"{label}.cited_method_scan_complete is not completion evidence; "
                "record one bibliography_candidate_screening disposition per reconciled candidate"
            )
        screenings = _as_list(
            source.get("bibliography_candidate_screening"),
            f"{label}.bibliography_candidate_screening",
            errors,
        )
        screened_ids: set[str] = set()
        for j, item in enumerate(screenings):
            candidate_id, disposition = _validate_method_screening(
                item,
                label=f"{label}.bibliography_candidate_screening[{j}]",
                families=families,
                candidates_by_id=candidates_by_id,
                source_candidate_ids=bibliography_candidates.get(source_id, set()),
                errors=errors,
            )
            if candidate_id in screened_ids:
                errors.append(
                    f"{label}.bibliography_candidate_screening repeats candidate {candidate_id!r}"
                )
            elif candidate_id:
                screened_ids.add(candidate_id)
            unresolved = unresolved or disposition == "coverage_debt"
        expected_screened = bibliography_candidates.get(source_id, set())
        if screened_ids != expected_screened:
            missing_screening = sorted(expected_screened - screened_ids)
            extra_screening = sorted(screened_ids - expected_screened)
            if missing_screening:
                errors.append(
                    f"{label}.bibliography_candidate_screening missing reconciled candidate(s): "
                    + ", ".join(missing_screening)
                )
            if extra_screening:
                errors.append(
                    f"{label}.bibliography_candidate_screening contains non-reconciled candidate(s): "
                    + ", ".join(extra_screening)
                )
            unresolved = True

    if audited_ids != set(selected_core_ids):
        missing = sorted(set(selected_core_ids) - audited_ids)
        extra = sorted(audited_ids - set(selected_core_ids))
        if missing:
            errors.append("method_family_audit missing selected core source(s): " + ", ".join(missing))
        if extra:
            errors.append("method_family_audit contains non-core source(s): " + ", ".join(extra))
    if final_status == "saturated" and unresolved:
        errors.append("final_status=saturated requires an audited method taxonomy with no unresolved method-family gaps")


def _validate_saturation(
    data: dict,
    *,
    project_root: Path,
    require_reading_evidence: bool,
    project_stage: str,
) -> list[str]:
    errors: list[str] = []

    final_status = str(data.get("final_status") or "").strip()
    if final_status not in _FINAL_STATUSES:
        errors.append("final_status must be 'saturated' or 'coverage_incomplete'")
    elif final_status == "coverage_incomplete" and project_stage != "exploration":
        errors.append("final_status=coverage_incomplete is only allowed as exploration debt")

    if not _nonempty_string(data.get("stop_reason")):
        errors.append("stop_reason is required")

    validate_bounded_provider_accounting(
        data.get("providers"),
        errors,
        require_queried=final_status == "saturated",
    )

    candidate_pool = _as_dict(data.get("candidate_pool"), "candidate_pool", errors)
    if not _nonempty_string(candidate_pool.get("artifact")):
        errors.append("candidate_pool.artifact is required")
    total_candidates = _int_or_none(candidate_pool.get("total_candidates"))
    if total_candidates is None or total_candidates < 0:
        errors.append("candidate_pool.total_candidates must be a non-negative integer")
    selected_core_ids = [
        str(item).strip()
        for item in _as_list(candidate_pool.get("selected_core_ids"), "candidate_pool.selected_core_ids", errors)
        if str(item).strip()
    ]
    if not selected_core_ids:
        errors.append("candidate_pool.selected_core_ids must name at least one core paper")
    if total_candidates is not None and selected_core_ids and total_candidates < len(selected_core_ids):
        errors.append("candidate_pool.total_candidates cannot be smaller than selected_core_ids")
    if not _nonempty_string(candidate_pool.get("selection_rationale")):
        errors.append("candidate_pool.selection_rationale is required")
    candidates_by_id, identities_by_id = _validate_candidate_ledger(candidate_pool, project_root, errors)
    if total_candidates is not None and total_candidates != len(candidates_by_id):
        errors.append("candidate_pool.total_candidates must equal the number of explicit candidate disposition records")
    for core_id in selected_core_ids:
        record = candidates_by_id.get(core_id)
        if record is None:
            errors.append(f"candidate_pool.candidates missing selected core paper {core_id!r}")
        elif str(record.get("disposition") or "").strip() != "core":
            errors.append(f"candidate_pool candidate {core_id!r} must have disposition='core'")
    ledger_core_ids = {
        candidate_id
        for candidate_id, record in candidates_by_id.items()
        if str(record.get("disposition") or "").strip() == "core"
    }
    if ledger_core_ids != set(selected_core_ids):
        unselected_core = sorted(ledger_core_ids - set(selected_core_ids))
        if unselected_core:
            errors.append(
                "candidate_pool contains core-disposition candidate(s) absent from selected_core_ids: "
                + ", ".join(unselected_core)
            )
    if final_status == "saturated":
        debt_candidates = sorted(
            candidate_id
            for candidate_id, record in candidates_by_id.items()
            if str(record.get("identity_status") or "").strip() == "unresolved"
            or str(record.get("disposition") or "").strip() == "coverage_debt"
        )
        if debt_candidates:
            errors.append(
                "final_status=saturated cannot retain unresolved/coverage-debt candidates: "
                + ", ".join(debt_candidates)
            )

    bibliography_candidates = _validate_bibliography_reconciliation(
        data.get("bibliography_reconciliation"),
        project_root=project_root,
        selected_core_ids=selected_core_ids,
        candidates_by_id=candidates_by_id,
        identities_by_id=identities_by_id,
        final_status=final_status,
        errors=errors,
    )
    _validate_method_family_audit(
        data.get("method_family_audit"),
        selected_core_ids=selected_core_ids,
        candidates_by_id=candidates_by_id,
        bibliography_candidates=bibliography_candidates,
        final_status=final_status,
        errors=errors,
    )

    citation_graph = _as_dict(data.get("citation_graph"), "citation_graph", errors)
    seed_records = _as_list(citation_graph.get("seeds"), "citation_graph.seeds", errors)
    seeds_by_id: dict[str, dict] = {}
    for i, raw_seed in enumerate(seed_records):
        seed = _as_dict(raw_seed, f"citation_graph.seeds[{i}]", errors)
        seed_id = str(seed.get("id") or "").strip()
        if not seed_id:
            errors.append(f"citation_graph.seeds[{i}].id is required")
            continue
        seeds_by_id[seed_id] = seed
        coverage_status = str(seed.get("coverage_status") or "").strip()
        if coverage_status not in _COVERAGE_STATUSES:
            errors.append(f"citation_graph.seeds[{i}].coverage_status must be one of {sorted(_COVERAGE_STATUSES)}")
        gaps = [str(g).strip() for g in _as_list(seed.get("gaps", []), f"citation_graph.seeds[{i}].gaps", errors) if str(g).strip()]
        if final_status == "saturated":
            if coverage_status != "saturated":
                errors.append(f"citation_graph.seeds[{i}].coverage_status must be 'saturated' when final_status='saturated'")
            if gaps:
                errors.append(f"citation_graph.seeds[{i}].gaps must be empty when final_status='saturated'")
        for side in ("references_checked", "citations_checked"):
            checked = seed.get(side) is True
            if checked:
                continue
            if final_status == "saturated":
                errors.append(f"citation_graph.seeds[{i}].{side} must be true when final_status='saturated'")
                continue
            if coverage_status in {"not_covered", "unavailable"} and gaps:
                continue
            errors.append(
                f"citation_graph.seeds[{i}].{side} must be true, unless coverage_status is not_covered/unavailable with gaps"
            )

    missing_core = [paper_id for paper_id in selected_core_ids if paper_id not in seeds_by_id]
    if missing_core:
        errors.append(f"citation_graph.seeds missing selected core paper(s): {', '.join(missing_core)}")

    if require_reading_evidence:
        source_first = _as_dict(data.get("source_first_reading", {}), "source_first_reading", errors)
        metadata_only = [
            str(item).strip()
            for item in _as_list(
                source_first.get("metadata_only_not_evidence_ready", []),
                "source_first_reading.metadata_only_not_evidence_ready",
                errors,
            )
            if str(item).strip()
        ]
        if metadata_only:
            errors.append(
                "metadata-only literature notes cannot satisfy knowledge_layers.require_literature_reading_evidence=true: "
                + ", ".join(metadata_only)
            )

    return errors


def _count_nonempty_rows(text: str, *, path: Path) -> tuple[int, list[Row]]:
    """
    Count non-empty Markdown table rows in the standard literature_queries.md table.
    A row is considered non-empty if it has a plausible ISO-like UTC timestamp in column 1.
    """
    text = (text or "").replace("\r\n", "\n").replace("\r", "\n")
    lines = text.splitlines()
    rows: list[Row] = []
    for i, ln in enumerate(lines, start=1):
        s = ln.strip()
        if not s.startswith("|"):
            continue
        # Skip header separators like |---|---|...
        if re.match(r"^\|\s*-{3,}\s*\|", s):
            continue
        # Split cells.
        parts = [p.strip() for p in s.strip("|").split("|")]
        if len(parts) < 2:
            continue
        ts = parts[0]
        # Template empty row: all cells empty.
        if all(not c for c in parts):
            continue
        # Count as non-empty only if timestamp looks filled (keeps the template placeholder row from counting).
        if _ISO_TS.match(ts):
            rows.append(Row(path=path, line=i, text=ln))
    return len(rows), rows


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--notes", type=Path, required=True, help="Path to research_contract.md (or equivalent).")
    args = ap.parse_args()

    if not args.notes.is_file():
        print(f"ERROR: notes not found: {args.notes}")
        return 2

    cfg = load_team_config(args.notes)
    if not cfg.feature_enabled("literature_trace_gate", default=True):
        print("[skip] literature trace gate disabled by research_team_config")
        return 0
    if not _gate_is_applicable(cfg):
        print("[skip] literature trace gate not applicable (references_gate and knowledge_layers_gate are disabled)")
        return 0

    # Resolve project root similarly to other gates.
    note_dir = args.notes.parent.resolve()
    project_root = note_dir
    if getattr(cfg, "path", None):
        try:
            project_root = cfg.path.parent.resolve()  # type: ignore[union-attr]
        except Exception:
            project_root = note_dir

    trace_path = _resolve_project_path(project_root, _trace_path_from_config(cfg))
    saturation_path = _resolve_project_path(project_root, _saturation_path_from_config(cfg))

    if not trace_path.is_file():
        print("[fail] literature trace gate failed")
        print(f"[error] Missing literature query trace log: {trace_path}")
        print("[hint] Create it (scaffold creates it automatically), or append a row via:")
        print(
            '  python3 "${SKILL_DIR:-$(for r in "${CLAUDE_CONFIG_DIR:-$HOME/.claude}" "${CODEX_HOME:-$HOME/.codex}" "$HOME/.config/opencode" "$HOME/.kimi-code"; do [ -d "$r/skills/research-team" ] && echo "$r/skills/research-team" && break; done || true)}/scripts/bin/literature_fetch.py" trace-add '
            '--source \"Manual\" --query \"...\" --decision \"...\"'
        )
        return 1

    try:
        txt = trace_path.read_text(encoding="utf-8", errors="replace")
    except Exception as exc:
        print(f"[error] Failed to read trace log: {trace_path} ({exc})")
        return 2

    n, rows = _count_nonempty_rows(txt, path=trace_path)
    if n <= 0:
        print("[fail] literature trace gate failed")
        print(f"[error] Trace log has no non-empty rows beyond the template header: {trace_path}")
        print("[hint] Append at least one row documenting query -> shortlist -> decision.")
        return 1

    if not saturation_path.is_file():
        print("[fail] literature trace gate failed")
        print(f"[error] Missing literature saturation artifact: {saturation_path}")
        print("[hint] Create it with provider coverage, candidate-pool, and citation/reference graph checks.")
        return 1

    try:
        saturation = json.loads(saturation_path.read_text(encoding="utf-8", errors="replace"))
    except json.JSONDecodeError as exc:
        print("[fail] literature trace gate failed")
        print(f"[error] Invalid JSON in literature saturation artifact: {saturation_path} ({exc})")
        return 2
    except Exception as exc:
        print(f"[error] Failed to read saturation artifact: {saturation_path} ({exc})")
        return 2

    if not isinstance(saturation, dict):
        print("[fail] literature trace gate failed")
        print(f"[error] Literature saturation artifact must be a JSON object: {saturation_path}")
        return 1

    errors = _validate_saturation(
        saturation,
        project_root=project_root,
        require_reading_evidence=_require_reading_evidence(cfg),
        project_stage=_project_stage(cfg),
    )
    if errors:
        print("[fail] literature trace gate failed")
        print(f"[error] Literature saturation artifact is incomplete: {saturation_path}")
        for error in errors:
            print(f"- {error}")
        return 1

    print("[ok] literature trace gate passed")
    print(f"- trace: {trace_path}")
    print(f"- non-empty rows: {n}")
    print(f"- saturation: {saturation_path}")
    print(f"- final_status: {saturation.get('final_status')}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
