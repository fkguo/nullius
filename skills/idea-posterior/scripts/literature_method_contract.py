"""Method-family taxonomy and per-bibliography-candidate screening gate."""

from __future__ import annotations

from typing import Any

from literature_ledger_primitives import SCREENING_DISPOSITIONS, text
from literature_method_evidence import validate_method_description


def validate_method_audit(
    ledger: dict[str, Any],
    selected_ids: list[str],
    bibliography_candidates: dict[str, set[str]],
    problems: list[str],
) -> dict[str, Any]:
    method = ledger.get("method_family_audit")
    taxonomy = method.get("taxonomy") if isinstance(method, dict) else None
    source_audits = method.get("source_audits") if isinstance(method, dict) else None
    if not isinstance(taxonomy, list):
        problems.append("detailed ledger method_family_audit.taxonomy must be an array")
        taxonomy = []
    families: set[str] = set()
    for index, family in enumerate(taxonomy):
        family_id = text(family.get("id")) if isinstance(family, dict) else ""
        if not family_id or family_id in families:
            problems.append(f"detailed ledger method_family_audit.taxonomy[{index}].id is missing or duplicated")
        else:
            families.add(family_id)
    if selected_ids and not families:
        problems.append("detailed ledger method taxonomy must not be empty")
    if not isinstance(source_audits, list):
        problems.append("detailed ledger method_family_audit.source_audits must be an array")
        source_audits = []
    audited_ids: set[str] = set()
    source_descriptions = 0
    cited_descriptions = 0
    unresolved_gaps = 0
    complete = True
    for index, audit in enumerate(source_audits):
        label = f"detailed ledger method_family_audit.source_audits[{index}]"
        if not isinstance(audit, dict):
            problems.append(f"{label} must be an object")
            complete = False
            continue
        source_id = text(audit.get("source_id"))
        if not source_id or source_id in audited_ids:
            problems.append(f"{label}.source_id is missing or duplicated")
            complete = False
            continue
        audited_ids.add(source_id)
        paper_methods = audit.get("paper_method_descriptions")
        if not isinstance(paper_methods, list) or not paper_methods:
            problems.append(f"{label}.paper_method_descriptions must contain source-text method evidence")
            paper_methods = []
            complete = False
        for method_index, item in enumerate(paper_methods):
            valid, debt = validate_method_description(
                item,
                label=f"{label}.paper_method_descriptions[{method_index}]",
                families=families,
                disposition_field="disposition",
                problems=problems,
            )
            source_descriptions += int(valid and not debt)
            unresolved_gaps += int(debt)
            complete = complete and valid and not debt
        screenings = audit.get("bibliography_candidate_screening")
        if "cited_method_descriptions" in audit or "cited_method_scan_complete" in audit:
            problems.append(
                f"{label} must use per-candidate bibliography_candidate_screening, "
                "not a cited-method list or completion boolean"
            )
            complete = False
        if not isinstance(screenings, list):
            problems.append(f"{label}.bibliography_candidate_screening must be an array")
            screenings = []
            complete = False
        screened_ids: set[str] = set()
        for screening_index, screening in enumerate(screenings):
            screening_label = f"{label}.bibliography_candidate_screening[{screening_index}]"
            if not isinstance(screening, dict):
                problems.append(f"{screening_label} must be an object")
                complete = False
                continue
            candidate_id = text(screening.get("candidate_id"))
            disposition = text(screening.get("disposition"))
            if not candidate_id or candidate_id in screened_ids:
                problems.append(f"{screening_label}.candidate_id is missing or duplicated")
                complete = False
            else:
                screened_ids.add(candidate_id)
            if not text(screening.get("locator")) or not text(screening.get("evidence_basis")) or not text(screening.get("rationale")):
                problems.append(f"{screening_label} requires locator, evidence_basis, and rationale")
                complete = False
            if disposition not in SCREENING_DISPOSITIONS:
                problems.append(f"{screening_label}.disposition is invalid")
                complete = False
            elif disposition == "method_bearing":
                valid, debt = validate_method_description(
                    screening,
                    label=screening_label,
                    families=families,
                    disposition_field="method_disposition",
                    problems=problems,
                )
                cited_descriptions += int(valid and not debt)
                unresolved_gaps += int(debt)
                complete = complete and valid and not debt
            elif disposition == "coverage_debt":
                unresolved_gaps += 1
                complete = False
            elif disposition == "not_method_bearing" and text(screening.get("evidence_basis")) != "source_text":
                problems.append(
                    f"{screening_label}.evidence_basis must be 'source_text' for not_method_bearing; "
                    "title/year metadata alone is insufficient"
                )
                complete = False
            elif any(field in screening for field in ("description", "method_features", "family_ids", "method_disposition")):
                problems.append(f"{screening_label}: only method_bearing may carry method classification fields")
                complete = False
        expected_screened = bibliography_candidates.get(source_id, set())
        missing = expected_screened - screened_ids
        if missing or screened_ids - expected_screened:
            problems.append(f"{label}.bibliography_candidate_screening does not cover exactly the reconciled candidates")
            unresolved_gaps += len(missing)
            complete = False
    selected_set = set(selected_ids)
    if audited_ids != selected_set:
        problems.append("detailed ledger method audit core set differs from selected_core_ids")
        complete = False
    return {
        "status": "audited" if complete and bool(families or not selected_ids) and unresolved_gaps == 0 else "coverage_debt",
        "core_sources_total": len(selected_ids),
        "core_sources_audited": len(audited_ids & selected_set),
        "taxonomy_families": len(families),
        "source_method_descriptions_audited": source_descriptions,
        "cited_method_descriptions_audited": cited_descriptions,
        "unresolved_method_family_gaps": unresolved_gaps,
    }
