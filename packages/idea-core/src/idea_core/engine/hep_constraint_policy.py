from __future__ import annotations

import re
from typing import Any

from idea_core.engine.text_utils import contains_any, contains_unit_token, is_number, sanitize_text


PLACEHOLDER_METHOD_TOKENS = ("todo", "tbd", "unknown", "placeholder", "n/a", "unspecified")


def _claim_texts(node: dict[str, Any]) -> list[tuple[str, str]]:
    idea_card = node.get("idea_card")
    if not isinstance(idea_card, dict):
        return []
    claims = idea_card.get("claims")
    if not isinstance(claims, list):
        return []
    claim_texts: list[tuple[str, str]] = []
    for idx, claim in enumerate(claims):
        if not isinstance(claim, dict):
            continue
        claim_text = sanitize_text(claim.get("claim_text"), fallback="")
        if claim_text:
            claim_texts.append((f"idea_card.claims[{idx}].claim_text", claim_text))
    return claim_texts


def _make_finding(*, heuristic_class: str, validator_id: str, code: str, severity: str, failure_mode: str, target_field: str, suggested_action: str, message: str, operator_hint: str | None = None) -> dict[str, str]:
    finding = {
        "heuristic_class": heuristic_class,
        "validator_id": validator_id,
        "code": code,
        "severity": severity,
        "failure_mode": failure_mode,
        "target_field": target_field,
        "suggested_action": suggested_action,
        "message": message,
    }
    if operator_hint:
        finding["operator_hint"] = operator_hint
    return finding


def _dedupe_findings(findings: list[dict[str, str]]) -> list[dict[str, str]]:
    deduped: list[dict[str, str]] = []
    seen: set[tuple[str, str, str, str]] = set()
    for finding in findings:
        key = (
            finding["heuristic_class"],
            finding["validator_id"],
            finding["code"],
            finding["target_field"],
        )
        if key in seen:
            continue
        seen.add(key)
        deduped.append(finding)
    return deduped


def _append_claim_findings(findings: list[dict[str, str]], claim_texts: list[tuple[str, str]]) -> None:
    for target_field, claim_text in claim_texts:
        lowered = claim_text.lower()
        has_number = any(ch.isdigit() for ch in lowered)
        if has_number and contains_any(lowered, ("mass", "energy", "width")) and not contains_unit_token(lowered, ("tev", "gev", "mev", "kev", "ev")):
            findings.append(_make_finding(heuristic_class="consistency", validator_id="hep.dimension_units.v1", code="dimension_missing_unit_mass_energy", severity="major", failure_mode="physics_inconsistency", target_field=target_field, suggested_action="Attach explicit energy/mass units (e.g., GeV/TeV) to the quantitative claim and restate the numerical range.", message="Mass/energy-like quantity appears numeric but does not carry explicit units."))
        if has_number and "lifetime" in lowered and not contains_unit_token(lowered, ("s", "ms", "us", "ns", "ps", "fs")):
            findings.append(_make_finding(heuristic_class="consistency", validator_id="hep.dimension_units.v1", code="dimension_missing_unit_lifetime", severity="major", failure_mode="physics_inconsistency", target_field=target_field, suggested_action="Provide lifetime units (s/ms/us/ns/ps/fs) and ensure the numeric range matches the intended regime.", message="Lifetime claim appears numeric but lacks explicit time units."))
        for raw_value, is_percent in re.findall(r"(?:branching ratio|branching fraction|\bbr\b)[^0-9+-]{0,10}([+-]?\d+(?:\.\d+)?)\s*(%)?", lowered):
            value = float(raw_value) / 100.0 if is_percent == "%" else float(raw_value)
            if value < 0.0 or value > 1.0:
                findings.append(_make_finding(heuristic_class="consistency", validator_id="hep.known_constraints.v1", code="branching_ratio_out_of_range", severity="critical", failure_mode="physics_inconsistency", target_field=target_field, suggested_action="Constrain branching ratio to [0, 1] (or use percentage notation explicitly) and align normalization assumptions.", message="Branching-ratio-like quantity exceeds physical bounds [0, 1]."))
                break
        if "massless" not in lowered:
            continue
        for raw_value, _ in re.findall(r"\bmass\b[^0-9+-]{0,12}([+-]?\d+(?:\.\d+)?)\s*(tev|gev|mev|kev|ev)\b", lowered):
            if float(raw_value) > 0.0:
                findings.append(_make_finding(heuristic_class="consistency", validator_id="hep.known_constraints.v1", code="massless_positive_mass", severity="critical", failure_mode="physics_inconsistency", target_field=target_field, suggested_action="Resolve contradiction between 'massless' and positive mass value; either remove massless claim or set mass consistently to zero.", message="Claim asserts massless state but also gives a positive mass value."))
                break


def _append_compute_plan_findings(findings: list[dict[str, str]], node: dict[str, Any]) -> None:
    idea_card = node.get("idea_card")
    compute_plan = idea_card.get("minimal_compute_plan", []) if isinstance(idea_card, dict) else []
    if isinstance(compute_plan, list):
        for idx, step in enumerate(compute_plan):
            if not isinstance(step, dict):
                continue
            method = sanitize_text(step.get("method"), fallback="").lower()
            step_name = sanitize_text(step.get("step"), fallback="").lower()
            required_infra_raw = sanitize_text(step.get("required_infrastructure"), fallback="")
            required_infra = required_infra_raw.lower() if required_infra_raw else None
            if required_infra is not None:
                step["required_infrastructure"] = required_infra
            estimate = (
                float(step["estimated_compute_hours_log10"])
                if is_number(step.get("estimated_compute_hours_log10"))
                else None
            )
            if estimate is not None:
                step["estimated_compute_hours_log10"] = estimate
            method_target = f"idea_card.minimal_compute_plan[{idx}].method"
            infra_target = f"idea_card.minimal_compute_plan[{idx}].required_infrastructure"
            estimate_target = f"idea_card.minimal_compute_plan[{idx}].estimated_compute_hours_log10"
            step_target = f"idea_card.minimal_compute_plan[{idx}].step"
            if contains_any(method, PLACEHOLDER_METHOD_TOKENS):
                findings.append(_make_finding(heuristic_class="feasibility", validator_id="hep.compute_capability.v1", code="compute_plan_placeholder_method", severity="critical", failure_mode="not_computable", target_field=method_target, suggested_action="Replace placeholder compute method with an executable workflow (toolchain + measurable outputs + stopping criteria).", message="Compute plan method is placeholder-only and cannot be executed.", operator_hint="LimitExplorer"))
            if contains_any(step_name, PLACEHOLDER_METHOD_TOKENS):
                findings.append(_make_finding(heuristic_class="feasibility", validator_id="hep.compute_capability.v1", code="compute_plan_placeholder_step", severity="major", failure_mode="not_computable", target_field=step_target, suggested_action="Rewrite the compute step as a concrete task with a measurable deliverable instead of a placeholder label.", message="Compute plan step is placeholder-only and does not describe an executable task.", operator_hint="LimitExplorer"))
            if required_infra == "not_yet_feasible":
                findings.append(_make_finding(heuristic_class="feasibility", validator_id="hep.compute_capability.v1", code="required_infrastructure_not_yet_feasible", severity="critical", failure_mode="not_computable", target_field=infra_target, suggested_action="Downgrade claim scope to a feasible proxy or provide a staged plan that starts with computable validation steps.", message="Compute plan explicitly marks required infrastructure as not yet feasible.", operator_hint="LimitExplorer"))
            if estimate is not None and required_infra in {"laptop", "workstation"} and estimate >= 3.0:
                findings.append(_make_finding(heuristic_class="feasibility", validator_id="hep.compute_capability.v1", code="compute_hours_infrastructure_mismatch", severity="major", failure_mode="not_computable", target_field=estimate_target, suggested_action="Either raise required_infrastructure to match the declared compute hours or decompose the work into smaller staged tasks.", message="Declared compute hours and required infrastructure are internally inconsistent.", operator_hint="LimitExplorer"))


def build_hep_constraint_findings(node: dict[str, Any]) -> list[dict[str, str]]:
    claim_texts = _claim_texts(node)
    findings: list[dict[str, str]] = []
    if claim_texts:
        _append_claim_findings(findings, claim_texts)
    _append_compute_plan_findings(findings, node)
    return _dedupe_findings(findings)
