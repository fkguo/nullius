#!/usr/bin/env python3
from __future__ import annotations

import json
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[3]
WRITER_BIN = ROOT / "skills" / "research-writer" / "scripts" / "bin"
sys.path.insert(0, str(WRITER_BIN))

from research_writer_learn_discussion_logic import _extract_segments_text  # type: ignore


def test_discussion_logic_surfaces_semantic_selected_diagnostic_segment(tmp_path: Path) -> None:
    raw = "\n".join(
        [
            "\\documentclass{article}",
            "\\begin{document}",
            "\\begin{abstract}",
            "Short abstract.",
            "\\end{abstract}",
            "\\section{Introduction}",
            "We frame the problem and summarize the plan in broad terms.",
            "",
            "\\section{Results}",
            "The headline value agrees with the benchmark within the quoted error bar.",
            "",
            "\\section{Appendix Diagnostics}",
            "Repeating the fit without the subtraction constant leaves the central value within 0.2 sigma, "
            "which isolates that ingredient as non-essential to the claim. "
            "This paragraph is the real diagnostic even though it avoids the old keyword bucket.",
            "",
            "\\section{Conclusions}",
            "We close with the main implication.",
            "\\end{document}",
            "",
        ]
    )

    _, evidence0 = _extract_segments_text(
        raw,
        evidence_name="flattened_main.tex",
        mask_math=False,
        mask_cites=False,
        semantic_selection_path=None,
    )
    candidates = evidence0["semantic_selection"]["candidates"]
    target = next(candidate for candidate in candidates if "subtraction constant" in candidate["preview"])

    selection_path = tmp_path / "1234.56789.json"
    selection_path.write_text(
        json.dumps(
            {
                "status": "ok",
                "mode": "stub",
                "decisions": [
                    {
                        "candidate_id": target["id"],
                        "status": "selected",
                        "semantic_tags": ["diagnostics", "claim_boundary"],
                        "rationale": "Isolates the ingredient that could otherwise be mistaken for the main signal.",
                    }
                ],
            }
        ),
        encoding="utf-8",
    )

    segments, evidence = _extract_segments_text(
        raw,
        evidence_name="flattened_main.tex",
        mask_math=False,
        mask_cites=False,
        semantic_selection_path=selection_path,
    )

    names = [segment.name for segment in segments]
    diagnostic_segment = next(segment for segment in segments if "Diagnostics / uncertainties" in segment.name)

    assert "Diagnostics / uncertainties (semantic-selected)" in names
    assert "Why surfaced: Isolates the ingredient" in diagnostic_segment.text
    assert "Semantic tags: diagnostics, claim_boundary" in diagnostic_segment.text
    assert evidence["semantic_selection"]["adjudicator"]["status"] == "ok"
    assert evidence["semantic_selection"]["render_plan"]["mode"] == "semantic_selected"
