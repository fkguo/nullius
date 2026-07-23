"""Citation-graph and survey-core binding for a validated literature ledger."""

from __future__ import annotations

from typing import Any

from literature_candidate_contract import CandidateContext
from literature_ledger_primitives import survey_core_records, text


def validate_citation_graph(
    ledger: dict[str, Any],
    selected_ids: list[str],
    problems: list[str],
) -> bool:
    citation_graph = ledger.get("citation_graph")
    seeds = citation_graph.get("seeds") if isinstance(citation_graph, dict) else None
    complete = True
    if not isinstance(seeds, list):
        problems.append("detailed ledger citation_graph.seeds must be an array")
        seeds = []
        complete = False
    graph_ids: set[str] = set()
    for index, seed in enumerate(seeds):
        label = f"detailed ledger citation_graph.seeds[{index}]"
        if not isinstance(seed, dict):
            problems.append(f"{label} must be an object")
            complete = False
            continue
        seed_id = text(seed.get("id"))
        if not seed_id or seed_id in graph_ids:
            problems.append(f"{label}.id is missing or duplicated")
            complete = False
        else:
            graph_ids.add(seed_id)
        gaps = seed.get("gaps")
        if seed.get("references_checked") is not True or seed.get("citations_checked") is not True:
            problems.append(f"{label} must record bounded reference and citation checks")
            complete = False
        if text(seed.get("coverage_status")) != "saturated" or not isinstance(gaps, list) or gaps:
            problems.append(f"{label} must be saturated with no graph coverage gaps")
            complete = False
    if graph_ids != set(selected_ids):
        problems.append("detailed ledger citation graph core set differs from selected_core_ids")
        complete = False
    return complete


def bind_survey_cores(
    survey: dict[str, Any],
    context: CandidateContext,
    problems: list[str],
) -> None:
    matched_ids: list[str] = []
    for index, (keys, title, year) in enumerate(survey_core_records(survey, problems)):
        matches = [
            candidate_id
            for candidate_id in context.selected_ids
            if context.identities.get(candidate_id) and keys & context.identities[candidate_id].keys
        ]
        if len(matches) != 1:
            problems.append(
                f"literature_survey_v1 core identity set does not match detailed ledger at core paper index {index}"
            )
            continue
        match = matches[0]
        matched_ids.append(match)
        identity = context.identities[match]
        if title != identity.title or year != identity.year:
            problems.append(
                f"literature_survey_v1 core identity metadata does not match detailed ledger candidate {match!r}"
            )
    if len(matched_ids) != len(set(matched_ids)) or set(matched_ids) != set(context.selected_ids):
        problems.append("literature_survey_v1 core identity set differs from detailed ledger selected_core_ids")
