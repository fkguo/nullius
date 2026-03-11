#!/usr/bin/env python3
from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts" / "lib"))

from semantic_packet_curator import CandidateRecord, curate_candidates


def _candidate(candidate_id: str, rank: int) -> CandidateRecord:
    return CandidateRecord(
        candidate_id=candidate_id,
        unit="tex_section",
        label=f"Section {candidate_id}",
        source_path=f"main.tex:{rank}",
        start_line=rank,
        end_line=rank + 1,
        preview=f"preview {candidate_id}",
        text=f"text for {candidate_id}",
        hints={"fallback_rank": rank},
        fallback_rank=rank,
    )


def test_curator_uses_selected_decision_when_available(tmp_path: Path) -> None:
    selection_path = tmp_path / "selection.json"
    selection_path.write_text(
        json.dumps(
            {
                "status": "ok",
                "mode": "stub",
                "decisions": [
                    {
                        "candidate_id": "section-002",
                        "status": "selected",
                        "semantic_tags": ["results", "diagnostics"],
                        "rationale": "Contains the decisive error-budget paragraph.",
                    }
                ],
            }
        ),
        encoding="utf-8",
    )

    artifact = curate_candidates(
        selection_kind="draft_focus_sections",
        candidates=[_candidate("section-001", 1), _candidate("section-002", 2)],
        adjudication_path=selection_path,
        max_primary=2,
        fallback_count=2,
    )

    assert artifact["adjudicator"]["status"] == "ok"
    assert artifact["render_plan"]["mode"] == "semantic_selected"
    assert artifact["render_plan"]["primary_candidate_ids"] == ["section-002"]
    selected = {item["id"]: item for item in artifact["candidates"]}["section-002"]
    assert selected["decision"]["semantic_tags"] == ["results", "diagnostics"]


def test_curator_fails_closed_when_selection_missing(tmp_path: Path) -> None:
    artifact = curate_candidates(
        selection_kind="draft_focus_sections",
        candidates=[_candidate("section-001", 1), _candidate("section-002", 2)],
        adjudication_path=tmp_path / "missing.json",
        max_primary=1,
        fallback_count=1,
    )

    assert artifact["adjudicator"]["status"] == "unavailable"
    assert artifact["render_plan"]["mode"] == "candidate_fallback"
    assert artifact["render_plan"]["primary_candidate_ids"] == ["section-001"]


def test_curator_falls_back_when_no_adjudication_path_is_provided() -> None:
    artifact = curate_candidates(
        selection_kind="draft_focus_sections",
        candidates=[_candidate("section-001", 1), _candidate("section-002", 2)],
        adjudication_path=None,
        max_primary=1,
        fallback_count=1,
    )

    assert artifact["adjudicator"]["mode"] == "none"
    assert artifact["adjudicator"]["status"] == "abstained"
    assert artifact["render_plan"]["mode"] == "candidate_fallback"
    assert artifact["render_plan"]["primary_candidate_ids"] == ["section-001"]


def test_curator_promotes_uncertain_when_no_selected(tmp_path: Path) -> None:
    selection_path = tmp_path / "selection.json"
    selection_path.write_text(
        json.dumps(
            {
                "status": "ok",
                "decisions": [
                    {
                        "candidate_id": "section-002",
                        "status": "uncertain",
                        "semantic_tags": ["diagnostics"],
                        "rationale": "Looks critical but evidence is incomplete.",
                    }
                ],
            }
        ),
        encoding="utf-8",
    )

    artifact = curate_candidates(
        selection_kind="discussion_logic_diagnostics",
        candidates=[_candidate("section-001", 1), _candidate("section-002", 2)],
        adjudication_path=selection_path,
        max_primary=2,
        fallback_count=2,
    )

    assert artifact["adjudicator"]["status"] == "ok"
    assert artifact["render_plan"]["mode"] == "semantic_uncertain"
    assert artifact["render_plan"]["primary_candidate_ids"] == ["section-002"]
