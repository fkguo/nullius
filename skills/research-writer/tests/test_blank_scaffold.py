"""The format initializer must not select science or destroy a manuscript."""

import hashlib
import json
from pathlib import Path
import subprocess
import sys

SCRIPT = Path(__file__).resolve().parents[1] / "scripts/bin/research_writer_scaffold.py"


def scaffold(project, output, *extra):
    return subprocess.run(
        [sys.executable, str(SCRIPT), "--project-root", str(project), "--tag", "M1", "--out", str(output), *extra],
        capture_output=True, text=True,
    )


def test_blank_scaffold_does_not_promote_first_equation_figure_or_results(tmp_path):
    project = tmp_path / "project"
    project.mkdir()
    (project / "research_notebook.md").write_text("# Scientific title\n## Preliminary rejected model\n$$\nBAD_FIRST_EQUATION = 999\n$$\n")
    (project / "research_contract.md").write_text("# Accepted result is elsewhere\n")
    (project / "Draft_Derivation.md").write_text("LEGACY_SCIENCE_NOT_A_DRAFT\n")
    run = project / "artifacts/runs/M1"
    run.mkdir(parents=True)
    (run / "analysis.json").write_text(json.dumps({"results": {"rejected_fit": 123456}}))
    (run / "first_figure.pdf").write_bytes(b"not the scientific figure selected by a researcher")
    (run / "manifest.json").write_text(json.dumps({"outputs": ["first_figure.pdf"]}))
    paper = project / "paper"
    result = scaffold(project, paper)
    assert result.returncode == 0, result.stderr
    tex = (paper / "main.tex").read_text()
    assert "TODO" in tex
    for rejected in ("BAD_FIRST_EQUATION", "Scientific title", "123456", "LEGACY_SCIENCE", "first_figure"):
        assert rejected not in tex
    assert not list((paper / "figures").iterdir())
    exported = json.loads((paper / "export_manifest.json").read_text())
    assert exported["status"] == "blank_scaffold"
    assert exported["compile"]["status"] == "not_run"
    for relative in [exported["paper"]["main_tex"], *exported["paper"]["bib"], exported["trace"]["run_json"]]:
        assert (paper / relative).is_file()
    assert "pdf" not in exported["paper"]


def test_existing_manuscript_is_never_removed_or_overwritten(tmp_path):
    paper = tmp_path / "paper"
    paper.mkdir()
    original = b"\\section{Reviewed result}\nThe author's current draft.\n"
    (paper / "main.tex").write_bytes(original)
    result = scaffold(tmp_path, paper)
    assert result.returncode != 0
    assert (paper / "main.tex").read_bytes() == original
    assert set(p.name for p in paper.iterdir()) == {"main.tex"}


def test_run_card_is_opaque_and_copied_exactly(tmp_path):
    raw = b'[ { "future_field": [1, true, null] } ]\n'
    card = tmp_path / "source_card.json"
    card.write_bytes(raw)
    paper = tmp_path / "paper"
    result = scaffold(tmp_path, paper, "--run-card", str(card))
    assert result.returncode == 0, result.stderr
    assert (paper / "run_card.json").read_bytes() == raw
    exported = json.loads((paper / "export_manifest.json").read_text())
    assert exported["run_card"] == {"path": "run_card.json", "sha256": hashlib.sha256(raw).hexdigest()}


def test_invalid_run_card_fails_before_creating_paper(tmp_path):
    card = tmp_path / "source_card.json"
    card.write_text("{invalid json")
    paper = tmp_path / "paper"
    assert scaffold(tmp_path, paper, "--run-card", str(card)).returncode != 0
    assert not paper.exists()


def test_plain_text_metadata_cannot_break_tex_structure(tmp_path):
    paper = tmp_path / "paper"
    result = scaffold(tmp_path, paper, "--title", r"A & B: 50% {x}_y", "--authors", "A #1")
    assert result.returncode == 0, result.stderr
    tex = (paper / "main.tex").read_text()
    assert r"\title{A \& B: 50\% \{x\}\_y}" in tex
    assert r"\author{A \#1}" in tex
