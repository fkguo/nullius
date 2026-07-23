"""Runtime binding for exact-pinned literature reconciliation and method ledgers."""

from __future__ import annotations

from pathlib import Path
from typing import Any

from literature_bibliography_contract import validate_bibliography
from literature_candidate_contract import validate_candidate_pool
from literature_ledger_primitives import (
    compare_summary,
    resolve_project_json,
    text,
    validate_bounded_provider_accounting,
)
from literature_ledger_completion import bind_survey_cores, validate_citation_graph
from literature_method_contract import validate_method_audit


def validate_bound_coverage_closure(
    survey: dict[str, Any],
    project_root: Path,
) -> list[str]:
    problems: list[str] = []
    coverage = survey.get("coverage")
    if not isinstance(coverage, dict):
        return ["literature_survey_v1.coverage must be an object before ledger binding"]
    bibliography_summary = coverage.get("bibliography_reconciliation")
    method_summary = coverage.get("method_family_audit")
    if not isinstance(bibliography_summary, dict) or not isinstance(method_summary, dict):
        return ["coverage reconciliation summaries must be objects before ledger binding"]
    bibliography_ref = bibliography_summary.get("artifact_ref")
    method_ref = method_summary.get("artifact_ref")
    if bibliography_ref != method_ref:
        return [
            "bibliography_reconciliation.artifact_ref and method_family_audit.artifact_ref "
            "must pin the same combined ledger; cross-artifact receipt reuse is forbidden"
        ]
    ledger = resolve_project_json(
        bibliography_ref,
        project_root,
        "coverage literature ledger artifact_ref",
        problems,
    )
    if ledger is None:
        return problems

    ledger_status = text(ledger.get("final_status"))
    provider_complete = validate_bounded_provider_accounting(
        ledger.get("providers"),
        problems,
        label="detailed ledger providers",
        require_queried=ledger_status == "saturated",
    )
    if not text(ledger.get("stop_reason")):
        problems.append("detailed ledger stop_reason is required")
    context = validate_candidate_pool(ledger, ledger_status, project_root, problems)
    if context is None:
        return problems

    bibliography_candidates, bibliography_expected = validate_bibliography(
        ledger,
        context,
        project_root,
        problems,
    )
    compare_summary(
        bibliography_summary,
        bibliography_expected,
        "bibliography_reconciliation",
        problems,
    )
    method_expected = validate_method_audit(
        ledger,
        context.selected_ids,
        bibliography_candidates,
        problems,
    )
    method = ledger.get("method_family_audit")
    declared_method_status = text(method.get("status")) if isinstance(method, dict) else ""
    if declared_method_status != method_expected["status"]:
        problems.append(
            "detailed ledger method_family_audit.status does not match the status derived from its screening records"
        )
    compare_summary(method_summary, method_expected, "method_family_audit", problems)

    graph_complete = validate_citation_graph(ledger, context.selected_ids, problems)
    bind_survey_cores(survey, context, problems)
    selected_set = set(context.selected_ids)
    derived_status = "saturated" if (
        provider_complete
        and not context.debt_candidate_ids
        and context.ledger_core_ids == selected_set
        and bibliography_expected["status"] == "reconciled"
        and method_expected["status"] == "audited"
        and graph_complete
    ) else "coverage_incomplete"
    if ledger_status != derived_status:
        problems.append("detailed ledger final_status does not match recomputed coverage closure")
    saturation = text(coverage.get("saturation"))
    if saturation == "saturated" and ledger_status != "saturated":
        problems.append("saturated survey requires detailed ledger final_status=saturated")
    if saturation == "coverage_incomplete" and ledger_status not in {"coverage_incomplete", "saturated"}:
        problems.append("coverage_incomplete survey has an invalid detailed ledger final_status")
    return problems
