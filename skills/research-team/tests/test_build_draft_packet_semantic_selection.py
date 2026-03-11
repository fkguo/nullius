#!/usr/bin/env python3
from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[3]
PREFLIGHT = ROOT / "skills" / "research-team" / "scripts" / "gates" / "check_tex_draft_preflight.py"
PACKET = ROOT / "skills" / "research-team" / "scripts" / "bin" / "build_draft_packet.py"


def test_build_draft_packet_surfaces_semantic_selected_appendix(tmp_path: Path) -> None:
    tex = tmp_path / "main.tex"
    bib = tmp_path / "references.bib"
    out = tmp_path / "D0-r1_draft_packet.md"
    structure = tmp_path / "D0-r1_draft_structure.json"
    selection = tmp_path / "selection.json"

    tex.write_text(
        "\n".join(
            [
                "\\documentclass{article}",
                "\\begin{document}",
                "\\section{Introduction}",
                "We summarize the setup and cite the relevant source. \\cite{Key1}",
                "",
                "\\section{Methods}",
                "The derivation introduces the estimator and the matching conditions.",
                "",
                "\\section{Results}",
                "The central plot is stable across the nominal fit window.",
                "",
                "\\section{Appendix Diagnostics}",
                "Repeating the fit without the subtraction constant leaves the central value within 0.2 sigma,",
                "which is the decisive robustness check for the main claim even though the heading looks secondary.",
                "\\end{document}",
                "",
            ]
        ),
        encoding="utf-8",
    )
    bib.write_text(
        "\n".join(
            [
                "@article{Key1,",
                "  title = {Key},",
                "  author = {A},",
                "  year = {2024}",
                "}",
                "",
            ]
        ),
        encoding="utf-8",
    )
    selection.write_text(
        json.dumps(
            {
                "status": "ok",
                "mode": "stub",
                "decisions": [
                    {
                        "candidate_id": "section-004",
                        "status": "selected",
                        "semantic_tags": ["diagnostics", "robustness"],
                        "rationale": "Critical robustness paragraph lives in the appendix rather than the headline results section.",
                    }
                ],
            }
        ),
        encoding="utf-8",
    )

    subprocess.run(
        [sys.executable, str(PREFLIGHT), "--tex", str(tex), "--bib", str(bib), "--out-json", str(structure)],
        check=True,
        cwd=tmp_path,
    )
    subprocess.run(
        [
            sys.executable,
            str(PACKET),
            "--tag",
            "D0-r1",
            "--tex",
            str(tex),
            "--bib",
            str(bib),
            "--out",
            str(out),
            "--semantic-selection-json",
            str(selection),
        ],
        check=True,
        cwd=tmp_path,
    )

    packet_text = out.read_text(encoding="utf-8")
    structure_obj = json.loads(structure.read_text(encoding="utf-8"))

    assert "## Semantic Focus Selection" in packet_text
    assert "Appendix Diagnostics" in packet_text
    assert "Critical robustness paragraph lives in the appendix" in packet_text
    assert "## Focus Slices (semantic-selected)" in packet_text
    assert structure_obj["semantic_selection"]["selection_kind"] == "draft_focus_sections"
    assert structure_obj["semantic_selection"]["render_plan"]["mode"] == "semantic_selected"
    assert structure_obj["semantic_selection"]["render_plan"]["primary_candidate_ids"] == ["section-004"]
