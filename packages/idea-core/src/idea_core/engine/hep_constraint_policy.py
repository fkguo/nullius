from __future__ import annotations

import re
from typing import Any

from idea_core.engine.text_utils import contains_any, contains_unit_token, is_number, sanitize_text


HEP_INFRASTRUCTURE_RANKS = {
    "laptop": 0,
    "workstation": 1,
    "cluster": 2,
    "not_yet_feasible": 3,
}
HEP_COMPUTE_RUBRIC_RULES = (
    ("frontier_not_yet_feasible", ("exascale", "petabyte", "full detector reconstruction", "sign-problem lattice", "quantum gravity full simulation"), 4.0, "not_yet_feasible"),
    ("heavy_cluster", ("lattice", "detector simulation", "global fit", "nnlo", "multi-loop", "full monte carlo", "high-statistics simulation"), 3.1, "cluster"),
    ("batch_workstation", ("parameter scan", "mcmc", "bayesian fit", "markov chain", "event generation", "numerical integration", "grid scan"), 1.6, "workstation"),
    ("toy_laptop", ("toy", "analytic", "closed-form", "smoke", "deterministic", "back-of-envelope"), 0.0, "laptop"),
)
HEP_HEAVY_COMPUTE_TOKENS = (
    "lattice",
    "detector simulation",
    "global fit",
    "nnlo",
    "multi-loop",
    "monte carlo",
)
HEP_PLACEHOLDER_METHOD_TOKENS = ("todo", "tbd", "unknown", "placeholder", "n/a", "unspecified")


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


def _infer_hep_compute_rubric(*, method: str, step: str, claim_context: str) -> dict[str, Any]:
    context = " ".join([method, step, claim_context]).lower()
    for rubric_id, keywords, estimate, required_infrastructure in HEP_COMPUTE_RUBRIC_RULES:
        if contains_any(context, keywords):
            return {
                "rubric_id": rubric_id,
                "estimated_compute_hours_log10": float(estimate),
                "required_infrastructure": required_infrastructure,
            }
    return {
        "rubric_id": "baseline_workstation",
        "estimated_compute_hours_log10": 1.0,
        "required_infrastructure": "workstation",
    }


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


def _append_compute_plan_findings(findings: list[dict[str, str]], node: dict[str, Any], claim_texts: list[tuple[str, str]]) -> None:
    idea_card = node.get("idea_card")
    compute_plan = idea_card.get("minimal_compute_plan", []) if isinstance(idea_card, dict) else []
    heavy_claim_text = " ".join(text for _, text in claim_texts).lower()
    heavy_compute_claim = contains_any(heavy_claim_text, HEP_HEAVY_COMPUTE_TOKENS)
    has_cluster_like_step = False
    if isinstance(compute_plan, list):
        for idx, step in enumerate(compute_plan):
            if not isinstance(step, dict):
                continue
            method = sanitize_text(step.get("method"), fallback="").lower()
            step_name = sanitize_text(step.get("step"), fallback="").lower()
            rubric = _infer_hep_compute_rubric(method=method, step=step_name, claim_context=heavy_claim_text)
            rubric_estimate = float(rubric["estimated_compute_hours_log10"])
            rubric_infra = str(rubric["required_infrastructure"])
            required_infra = sanitize_text(step.get("required_infrastructure"), fallback="").lower() or rubric_infra
            step["required_infrastructure"] = required_infra
            estimate = float(step["estimated_compute_hours_log10"]) if is_number(step.get("estimated_compute_hours_log10")) else rubric_estimate
            step["estimated_compute_hours_log10"] = estimate
            if required_infra in {"cluster", "not_yet_feasible"}:
                has_cluster_like_step = True
            method_target = f"idea_card.minimal_compute_plan[{idx}].method"
            infra_target = f"idea_card.minimal_compute_plan[{idx}].required_infrastructure"
            estimate_target = f"idea_card.minimal_compute_plan[{idx}].estimated_compute_hours_log10"
            if contains_any(method, HEP_PLACEHOLDER_METHOD_TOKENS):
                findings.append(_make_finding(heuristic_class="feasibility", validator_id="hep.compute_feasibility.v1", code="compute_plan_placeholder_method", severity="critical", failure_mode="not_computable", target_field=method_target, suggested_action="Replace placeholder compute method with an executable workflow (toolchain + measurable outputs + stopping criteria).", message="Compute plan method is placeholder-only and cannot be executed.", operator_hint="LimitExplorer"))
            if required_infra == "not_yet_feasible":
                findings.append(_make_finding(heuristic_class="feasibility", validator_id="hep.compute_feasibility.v1", code="required_infrastructure_not_yet_feasible", severity="critical", failure_mode="not_computable", target_field=infra_target, suggested_action="Downgrade claim scope to a feasible proxy or provide a staged plan that starts with computable validation steps.", message="Compute plan explicitly marks required infrastructure as not yet feasible.", operator_hint="LimitExplorer"))
            if HEP_INFRASTRUCTURE_RANKS.get(required_infra, -1) < HEP_INFRASTRUCTURE_RANKS.get(rubric_infra, -1):
                severity = "critical" if rubric_infra in {"cluster", "not_yet_feasible"} else "major"
                findings.append(_make_finding(heuristic_class="feasibility", validator_id="hep.compute_feasibility.v1", code="required_infrastructure_below_rubric", severity=severity, failure_mode="not_computable", target_field=infra_target, suggested_action=f"Raise required_infrastructure to the HEP default rubric tier ({rubric_infra}) or narrow the compute scope to match declared infra.", message="Required infrastructure is below the HEP compute rubric for the declared method/claim complexity.", operator_hint="LimitExplorer"))
            if rubric_estimate - estimate >= 0.7:
                severity = "critical" if rubric_estimate >= 3.0 else "major"
                findings.append(_make_finding(heuristic_class="feasibility", validator_id="hep.compute_feasibility.v1", code="estimated_compute_hours_below_rubric", severity=severity, failure_mode="not_computable", target_field=estimate_target, suggested_action=f"Increase estimated_compute_hours_log10 to match the HEP default rubric ({rubric_estimate:.1f}) or decompose into a lower-cost staged proxy.", message="Compute-hour estimate is under-calibrated versus HEP rubric and risks a pseudo-computable plan.", operator_hint="LimitExplorer"))
            if estimate >= 3.0 and required_infra in {"laptop", "workstation"}:
                findings.append(_make_finding(heuristic_class="feasibility", validator_id="hep.compute_feasibility.v1", code="compute_hours_infrastructure_mismatch", severity="major", failure_mode="not_computable", target_field=infra_target, suggested_action="Align infrastructure tier with compute estimate (cluster or staged decomposition) before promotion.", message="Compute-hour estimate is inconsistent with declared infrastructure tier.", operator_hint="LimitExplorer"))
    if heavy_compute_claim and not has_cluster_like_step:
        findings.append(_make_finding(heuristic_class="feasibility", validator_id="hep.compute_feasibility.v1", code="heavy_claim_without_cluster_plan", severity="critical", failure_mode="not_computable", target_field="idea_card.minimal_compute_plan", suggested_action="Add at least one cluster-grade or staged feasibility step for heavy-compute claims (lattice/detector/global-fit class).", message="Claim implies heavy compute but plan lacks cluster-grade feasibility steps.", operator_hint="LimitExplorer"))


def build_hep_constraint_findings(node: dict[str, Any]) -> list[dict[str, str]]:
    claim_texts = _claim_texts(node)
    if not claim_texts:
        return []
    findings: list[dict[str, str]] = []
    _append_claim_findings(findings, claim_texts)
    _append_compute_plan_findings(findings, node, claim_texts)
    return _dedupe_findings(findings)
