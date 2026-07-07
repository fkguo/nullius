#!/usr/bin/env python3
"""Validate the close-prior deep-literature gate before posterior writeback.

This is a fail-closed structural gate. It does not score papers, and it does
not turn literature into Gaia evidence. It only checks that the literature
input is deep enough to be admissible for a posterior graph:

- the survey snowball records seed search, backward references, forward
  citations, and critique-specific search;
- core/close-prior papers have source-first read status, source links, and
  locators;
- negative novelty claims and tension_resolution upgrades carry the required
  reviewer/search/challenge evidence;
- Gaia anchors are proposition-level claim-grounding outputs, not paper-level
  or subagent-level conclusions.

`coverage_incomplete` can pass only as provisional posterior guidance; it cannot
claim allocation eligibility unless explicit exploratory allocation is allowed.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path
from typing import Any

DISCOVERY_METHODS = {
    "seed_search",
    "backward_references",
    "forward_citations",
    "critique_specific_search",
}
READ_STATUSES = {"full_text_read", "section_read", "metadata_only", "unavailable"}
SOURCE_READ_STATUSES = {"full_text_read", "section_read"}
REQUIRED_FULL_TEXT_SECTIONS = {
    "introduction",
    "formalism_method",
    "results_discussion",
    "conclusion_outlook",
}
MINIMUM_REPORT_HEADERS = {
    "reference",
    "read status",
    "same-scope",
    "supports",
    "weakens",
    "stale",
}
ARXIV_ID_RE = re.compile(r"(?:arxiv:)?(\d{4}\.\d{4,5})(?:v\d+)?", re.IGNORECASE)
DOI_ID_RE = re.compile(r"(10\.\d{4,9}/[^\s,;]+)", re.IGNORECASE)
RECID_ID_RE = re.compile(r"(?:recid|inspire|inspirehep)[^\d]*(\d{5,})", re.IGNORECASE)


def load_json(path: Path) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise ValueError(f"cannot read JSON {path}: {exc}") from exc


def _is_obj(value: Any) -> bool:
    return isinstance(value, dict)


def _non_empty_str(value: Any) -> bool:
    return isinstance(value, str) and bool(value.strip())


def _non_empty_list(value: Any) -> bool:
    return isinstance(value, list) and len(value) > 0


def _as_list(value: Any) -> list[Any]:
    return value if isinstance(value, list) else []


def _canonical_text(value: Any) -> str | None:
    if value is None:
        return None
    text = str(value).strip().lower()
    if not text:
        return None
    return re.sub(r"\s+", " ", re.sub(r"[^a-z0-9]+", " ", text)).strip() or None


def _canonical_year(value: Any) -> str | None:
    if value is None:
        return None
    match = re.search(r"\b(1[5-9]\d{2}|20\d{2}|21\d{2})\b", str(value))
    return match.group(1) if match else None


def _canonical_doi(value: Any) -> str | None:
    if value is None:
        return None
    match = DOI_ID_RE.search(str(value).strip())
    if not match:
        return None
    return match.group(1).rstrip(".").lower()


def _canonical_arxiv(value: Any) -> str | None:
    if value is None:
        return None
    match = ARXIV_ID_RE.search(str(value).strip())
    return match.group(1).lower() if match else None


def _canonical_recid(value: Any) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    if "." in text and not re.search(r"(?:recid|inspire|inspirehep)", text, re.IGNORECASE):
        return None
    prefixed = RECID_ID_RE.search(text)
    if prefixed:
        return prefixed.group(1)
    return text if re.fullmatch(r"\d{5,}", text) else None


def _non_singleton(values: list[str | None]) -> bool:
    return len({value for value in values if value}) > 1


def _contains_all_methods(rounds: list[Any]) -> set[str]:
    methods: set[str] = set()
    for entry in rounds:
        if _is_obj(entry):
            for method in _as_list(entry.get("discovery_methods")):
                if isinstance(method, str):
                    methods.add(method)
    return methods


def _validate_survey(survey: Any, problems: list[str]) -> str:
    if not _is_obj(survey):
        problems.append("literature_survey_v1 must be a JSON object")
        return "metadata_only"
    coverage = survey.get("coverage")
    if not _is_obj(coverage):
        problems.append("literature_survey_v1.coverage must be an object")
        return "metadata_only"
    status = coverage.get("saturation")
    if status not in {"saturated", "coverage_incomplete", "unknown"}:
        problems.append("literature_survey_v1.coverage.saturation must be saturated, coverage_incomplete, or unknown")
        status = "unknown"
    if status == "unknown":
        problems.append("literature_survey_v1.coverage.saturation=unknown cannot enter posterior writeback; record measured coverage_incomplete debt instead")
    rounds = _as_list(coverage.get("saturation_evidence"))
    for index, entry in enumerate(rounds):
        label = f"literature_survey_v1.coverage.saturation_evidence[{index}]"
        if not _is_obj(entry):
            problems.append(f"{label} must be an object")
            continue
        if entry.get("round") != index + 1:
            problems.append(f"{label}.round must equal {index + 1} (rounds are 1-based and contiguous)")
        screened = entry.get("expansion_candidates_screened")
        if not isinstance(screened, int) or screened <= 0:
            problems.append(f"{label}.expansion_candidates_screened must be a positive integer")
        new_core = entry.get("new_core_papers")
        if not isinstance(new_core, int) or new_core < 0:
            problems.append(f"{label}.new_core_papers must be a non-negative integer")
        if isinstance(screened, int) and isinstance(new_core, int) and new_core > screened:
            problems.append(f"{label}.new_core_papers cannot exceed expansion_candidates_screened")
        methods = _as_list(entry.get("discovery_methods"))
        if not methods:
            problems.append(f"{label}.discovery_methods must be non-empty")
        seen_methods: set[str] = set()
        for method_index, method in enumerate(methods):
            if method not in DISCOVERY_METHODS:
                problems.append(f"{label}.discovery_methods[{method_index}] must be one of {sorted(DISCOVERY_METHODS)}")
            elif method in seen_methods:
                problems.append(f"{label}.discovery_methods[{method_index}] must not repeat a method")
            if isinstance(method, str):
                seen_methods.add(method)
    if status == "saturated":
        if not rounds:
            problems.append("saturated survey has no measured expansion rounds")
        missing = DISCOVERY_METHODS - _contains_all_methods(rounds)
        if missing:
            problems.append(f"saturated survey is missing discovery methods: {sorted(missing)}")
        last = rounds[-1] if rounds else {}
        if not _is_obj(last):
            problems.append("last saturation evidence round must be an object")
        else:
            if not isinstance(last.get("expansion_candidates_screened"), int) or last.get("expansion_candidates_screened") <= 0:
                problems.append("last expansion round must screen at least one candidate")
            if last.get("new_core_papers") != 0:
                problems.append("last expansion round must add zero new core papers before saturated is legal")

    for index, paper in enumerate(_as_list(survey.get("papers"))):
        if not _is_obj(paper):
            problems.append(f"survey papers[{index}] must be an object")
            continue
        if paper.get("role") == "core":
            _validate_read_entry(paper, f"survey papers[{index}]", problems, require_source_read=True)
    return "saturated" if status == "saturated" else "coverage_incomplete"


def _validate_read_entry(entry: dict[str, Any], label: str, problems: list[str], *, require_source_read: bool) -> None:
    read_status = entry.get("read_status")
    if read_status not in READ_STATUSES:
        problems.append(f"{label}.read_status must be one of {sorted(READ_STATUSES)}")
    elif require_source_read and read_status not in SOURCE_READ_STATUSES:
        problems.append(f"{label} must be source-first read; metadata_only/unavailable cannot anchor Gaia likelihood")
    if not _non_empty_str(entry.get("source_link")) and not _non_empty_list(entry.get("source_links")):
        problems.append(f"{label} must record a source_link/source_links")
    if not _non_empty_str(entry.get("locator")) and not _non_empty_list(entry.get("read_locators")):
        problems.append(f"{label} must record a locator/read_locators")
    sections = set(x for x in _as_list(entry.get("sections_read") or entry.get("read_sections")) if isinstance(x, str))
    if read_status == "section_read" and not sections:
        problems.append(f"{label} section_read must record read_sections/sections_read")
    if read_status == "full_text_read":
        missing = REQUIRED_FULL_TEXT_SECTIONS - sections
        if missing:
            problems.append(f"{label} full_text_read is missing sections: {sorted(missing)}")
    identity = entry.get("identity_triangulation")
    if not _is_obj(identity):
        problems.append(f"{label} must record citation identity triangulation")
    else:
        if identity.get("verdict") != "consistent":
            problems.append(f"{label}.identity_triangulation.verdict must be consistent")
        providers = _as_list(identity.get("providers"))
        if len(providers) < 2:
            problems.append(f"{label}.identity_triangulation.providers must contain at least two provider records")
        provider_names: list[str | None] = []
        titles: list[str | None] = []
        years: list[str | None] = []
        dois: list[str | None] = []
        arxiv_ids: list[str | None] = []
        recids: list[str | None] = []
        for provider_index, provider in enumerate(providers):
            if not _is_obj(provider):
                problems.append(f"{label}.identity_triangulation.providers[{provider_index}] must be an object")
                continue
            for field in ("provider", "title", "year", "identifier"):
                if not _non_empty_str(provider.get(field)) and not isinstance(provider.get(field), int):
                    problems.append(f"{label}.identity_triangulation.providers[{provider_index}].{field} must be present")
            provider_names.append(_canonical_text(provider.get("provider")))
            titles.append(_canonical_text(provider.get("title")))
            years.append(_canonical_year(provider.get("year")))
            identifier = provider.get("identifier")
            dois.append(_canonical_doi(provider.get("doi")) or _canonical_doi(identifier))
            arxiv_ids.append(_canonical_arxiv(identifier))
            recids.append(_canonical_recid(identifier))
        known_provider_names = [name for name in provider_names if name]
        if len(set(known_provider_names)) != len(known_provider_names):
            problems.append(f"{label}.identity_triangulation.providers must be independent provider names")
        if identity.get("verdict") == "consistent":
            if _non_singleton(titles):
                problems.append(f"{label}.identity_triangulation.providers have conflicting titles despite verdict=consistent")
            if _non_singleton(years):
                problems.append(f"{label}.identity_triangulation.providers have conflicting years despite verdict=consistent")
            if _non_singleton(dois):
                problems.append(f"{label}.identity_triangulation.providers have conflicting DOIs despite verdict=consistent")
            if _non_singleton(arxiv_ids):
                problems.append(f"{label}.identity_triangulation.providers have conflicting arXiv ids despite verdict=consistent")
            if _non_singleton(recids):
                problems.append(f"{label}.identity_triangulation.providers have conflicting INSPIRE recids despite verdict=consistent")
    audit = entry.get("source_fidelity_audit")
    if not _is_obj(audit):
        problems.append(f"{label} must record source_fidelity_audit for the deep-read summary")
    else:
        if audit.get("status") != "pass":
            problems.append(f"{label}.source_fidelity_audit.status must be pass")
        if not _non_empty_str(audit.get("auditor")):
            problems.append(f"{label}.source_fidelity_audit.auditor must be present")
        if not _non_empty_list(audit.get("checked_locators")):
            problems.append(f"{label}.source_fidelity_audit.checked_locators must be non-empty")


def _validate_required_caveat_terms(entry: dict[str, Any], label: str, problems: list[str]) -> None:
    terms = [
        str(term).strip().lower()
        for term in _as_list(entry.get("required_late_caveat_terms") or entry.get("required_caveat_terms"))
        if str(term).strip()
    ]
    if not terms:
        return
    caveats = " ".join(str(x) for x in _as_list(entry.get("key_caveats"))) + " " + str(entry.get("caveat_summary", ""))
    lower = caveats.lower()
    missing_terms = [term for term in terms if term not in lower]
    if missing_terms:
        problems.append(
            f"{label} must record required late-section caveat terms; missing terms: {missing_terms}"
        )
    sections = set(x for x in _as_list(entry.get("sections_read") or entry.get("read_sections")) if isinstance(x, str))
    if "conclusion_outlook" not in sections and "results_discussion" not in sections:
        problems.append(f"{label} required late caveat terms need results_discussion or conclusion_outlook read coverage")


def _validate_matrix(matrix: Any, problems: list[str]) -> tuple[str, bool, bool | None]:
    if not _is_obj(matrix):
        problems.append("close-prior matrix must be a JSON object")
        return "metadata_only", False, None
    entries = _as_list(matrix.get("entries"))
    if not entries:
        problems.append("close-prior matrix must contain at least one entry")
    source_read_links: set[str] = set()
    for index, entry in enumerate(entries):
        if not _is_obj(entry):
            problems.append(f"close-prior entries[{index}] must be an object")
            continue
        label = f"close-prior entries[{index}]"
        _validate_read_entry(entry, label, problems, require_source_read=False)
        if entry.get("read_status") in {"metadata_only", "unavailable"} and _as_list(entry.get("gaia_anchor_refs")):
            problems.append(f"{label} is metadata_only/unavailable and cannot anchor Gaia likelihood")
        if entry.get("read_status") in {"metadata_only", "unavailable"}:
            if _as_list(entry.get("supports_subclaims")) or _as_list(entry.get("weakens_novelty_claims")):
                problems.append(f"{label} is metadata_only/unavailable and cannot support or weaken subclaims")
        if "same_scope" not in entry and "same_scope_status" not in entry:
            problems.append(f"{label} must record same-scope status")
        if "supports_subclaims" not in entry:
            problems.append(f"{label} must record supported subclaims, even if empty")
        if "weakens_novelty_claims" not in entry:
            problems.append(f"{label} must record weakened novelty claims, even if empty")
        if "stale_or_provisional" not in entry:
            problems.append(f"{label} must record whether the score is stale/provisional")
        _validate_required_caveat_terms(entry, label, problems)
        if entry.get("read_status") in SOURCE_READ_STATUSES:
            if isinstance(entry.get("source_link"), str):
                source_read_links.add(entry["source_link"])
            source_read_links.update(link for link in _as_list(entry.get("source_links")) if isinstance(link, str))

    critique = matrix.get("critique_search")
    if not _is_obj(critique) or not _non_empty_list(critique.get("queries")):
        problems.append("close-prior matrix must record critique_search.queries")
    if _is_obj(critique) and not _non_empty_list(critique.get("top_hits_reviewed")):
        problems.append("close-prior matrix must record critique_search.top_hits_reviewed")

    tension = matrix.get("tension_resolution")
    if _is_obj(tension) and tension.get("grade") not in {None, "weakest"}:
        if not _non_empty_list(tension.get("supporting_refs")):
            problems.append("tension_resolution above weakest must record supporting_refs")
        challenge_refs = tension.get("challenge_refs") or tension.get("competing_resolution_refs")
        if not _non_empty_list(challenge_refs):
            problems.append("tension_resolution above weakest must record challenge_refs or competing_resolution_refs")

    for index, claim in enumerate(_as_list(matrix.get("negative_novelty_claims"))):
        if not _is_obj(claim):
            problems.append(f"negative_novelty_claims[{index}] must be an object")
            continue
        gate = claim.get("reviewer_gate")
        if not _is_obj(gate):
            problems.append(f"negative_novelty_claims[{index}] requires reviewer_gate")
            continue
        for field in ("close_prior_matrix_checked", "critique_search_checked", "discussion_conclusion_checked"):
            if gate.get(field) is not True:
                problems.append(f"negative_novelty_claims[{index}].reviewer_gate.{field} must be true")
        if not _non_empty_list(gate.get("same_scope_exclusions")):
            problems.append(f"negative_novelty_claims[{index}] needs same_scope_exclusions for closest hits")

    for index, anchor in enumerate(_as_list(matrix.get("gaia_anchors"))):
        if not _is_obj(anchor):
            problems.append(f"gaia_anchors[{index}] must be an object")
            continue
        if anchor.get("anchor_source") != "claim_grounding":
            problems.append(f"gaia_anchors[{index}] must come from claim_grounding, not paper/subagent-level synthesis")
        for field in ("proposition", "quote", "locator", "source_link"):
            if not _non_empty_str(anchor.get(field)):
                problems.append(f"gaia_anchors[{index}].{field} must be a non-empty string")
        if _non_empty_str(anchor.get("source_link")) and anchor.get("source_link") not in source_read_links:
            problems.append(f"gaia_anchors[{index}].source_link must match a source-read close-prior entry")

    for index, item in enumerate(_as_list(matrix.get("subagent_inputs"))):
        if _is_obj(item) and item.get("used_in_gaia") is True and not _non_empty_str(item.get("claim_grounding_ref")):
            problems.append(f"subagent_inputs[{index}] was used in Gaia without claim_grounding_ref")

    status = matrix.get("coverage_status")
    if status not in {"saturated", "coverage_incomplete", "metadata_only"}:
        problems.append("close-prior matrix.coverage_status must be saturated, coverage_incomplete, or metadata_only")
        status = "metadata_only"
    exploratory = matrix.get("exploratory_allocation") is True
    if exploratory and status != "coverage_incomplete":
        problems.append("exploratory_allocation is only legal with coverage_incomplete")
    allocation_eligible = matrix.get("allocation_eligible")
    if allocation_eligible is not None and not isinstance(allocation_eligible, bool):
        problems.append("close-prior matrix.allocation_eligible must be a boolean when provided")
        allocation_eligible = None
    posterior_status = matrix.get("posterior_status")
    if posterior_status is not None and posterior_status not in {"current", "provisional", "stale"}:
        problems.append("close-prior matrix.posterior_status must be current, provisional, or stale when provided")
    if status != "saturated" and posterior_status == "current":
        problems.append("coverage_incomplete/metadata_only cannot declare posterior_status current")
    return status, exploratory, allocation_eligible


def _validate_report(report_text: str | None, matrix: Any, problems: list[str]) -> None:
    if report_text is None:
        problems.append("posterior_report_v1.md is required")
        return
    lower = report_text.lower()
    if "close-prior matrix" not in lower:
        problems.append("posterior report must contain a close-prior matrix section")
    missing = [header for header in MINIMUM_REPORT_HEADERS if header not in lower]
    if missing:
        problems.append(f"posterior report close-prior matrix is missing headers/columns: {missing}")
    if not re.search(r"\[[^\]\n]+\]\([^)]+\)", report_text):
        problems.append("posterior report must use clickable Markdown links for source/artifact references")
    if _is_obj(matrix):
        for index, entry in enumerate(_as_list(matrix.get("entries"))):
            if not _is_obj(entry):
                continue
            source_link = entry.get("source_link")
            source_links = _as_list(entry.get("source_links"))
            links = []
            if isinstance(source_link, str):
                links.append(source_link)
            links.extend(link for link in source_links if isinstance(link, str))
            if links and not any(link in report_text for link in links):
                problems.append(f"posterior report close-prior matrix is missing a clickable source link for entries[{index}]")


def validate_gate(survey: Any, matrix: Any, report_text: str | None, *, allow_exploratory: bool = False) -> list[str]:
    problems: list[str] = []
    survey_status = _validate_survey(survey, problems)
    matrix_status, exploratory, allocation_eligible = _validate_matrix(matrix, problems)
    _validate_report(report_text, matrix, problems)
    if matrix_status == "saturated" and survey_status != "saturated":
        problems.append("close-prior matrix claims saturated but literature_survey_v1 is not saturated")
    if exploratory and not allow_exploratory:
        problems.append("exploratory_allocation requires --allow-exploratory/--allow-exploratory-allocation")
    eligible_status = matrix_status == "saturated" or (
        matrix_status == "coverage_incomplete" and exploratory and allow_exploratory
    )
    if allocation_eligible is True and not eligible_status:
        problems.append("coverage_incomplete/metadata_only cannot be allocation_eligible unless explicit exploratory allocation is allowed")
    if matrix_status == "metadata_only":
        problems.append("metadata_only coverage cannot enter posterior writeback/allocation guidance")
    return problems


def literature_coverage_from_gate(matrix: dict[str, Any]) -> dict[str, Any]:
    coverage = {
        "status": matrix.get("coverage_status", "metadata_only"),
    }
    for source_key, target_key in (
        ("survey_ref", "survey_ref"),
        ("close_prior_matrix_ref", "close_prior_matrix_ref"),
        ("exploratory_allocation", "exploratory_allocation"),
    ):
        if source_key in matrix:
            coverage[target_key] = matrix[source_key]
    return coverage


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--survey-json", required=True)
    parser.add_argument("--matrix-json", required=True)
    parser.add_argument("--report-md", required=True)
    parser.add_argument("--allow-exploratory", action="store_true")
    args = parser.parse_args(argv)

    try:
        survey = load_json(Path(args.survey_json))
        matrix = load_json(Path(args.matrix_json))
        report_text = Path(args.report_md).read_text(encoding="utf-8")
    except (OSError, ValueError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2
    problems = validate_gate(survey, matrix, report_text, allow_exploratory=args.allow_exploratory)
    if problems:
        print("close-prior gate failed:", file=sys.stderr)
        for problem in problems:
            print(f"  - {problem}", file=sys.stderr)
        return 2
    print(json.dumps({"ok": True, "literature_coverage": literature_coverage_from_gate(matrix)}, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
