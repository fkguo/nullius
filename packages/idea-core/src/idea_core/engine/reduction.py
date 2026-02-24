from __future__ import annotations

from typing import Any

from idea_core.engine.utils import utc_now_iso


def derive_reduction_status(
    assumptions: list[dict[str, Any]],
    toy_check_result: str,
    reduction_type_valid: bool,
) -> str:
    has_violated = any(a.get("status") == "violated" for a in assumptions)
    has_pending = any(a.get("status") == "pending_verification" for a in assumptions)

    if has_violated:
        return "fail"
    if not reduction_type_valid:
        return "fail"
    if toy_check_result == "fail":
        return "fail"

    if reduction_type_valid and toy_check_result == "pass" and not has_pending:
        return "pass"

    return "partial"


def build_reduction_audit(
    *,
    abstract_problem: str,
    assumptions: list[dict[str, Any]],
    toy_check_result: str,
    reduction_type_valid: bool,
    skip_reason: str | None = None,
    failures: list[str] | None = None,
    warnings: list[str] | None = None,
    auditor_origin: dict[str, Any] | None = None,
) -> dict[str, Any]:
    status = derive_reduction_status(
        assumptions=assumptions,
        toy_check_result=toy_check_result,
        reduction_type_valid=reduction_type_valid,
    )

    audit: dict[str, Any] = {
        "status": status,
        "abstract_problem": abstract_problem,
        "assumptions": assumptions,
        "toy_check_result": toy_check_result,
        "reduction_type_valid": reduction_type_valid,
        "failures": failures or [],
        "warnings": warnings or [],
        "timestamp": utc_now_iso(),
    }
    if toy_check_result == "skipped":
        audit["skip_reason"] = (skip_reason or "toy_check_deferred").strip() or "toy_check_deferred"
    if auditor_origin is not None:
        audit["auditor_origin"] = auditor_origin
    return audit
