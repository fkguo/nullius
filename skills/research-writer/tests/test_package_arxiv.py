"""Portable-file and source-preservation checks; PDF fixtures are only bytes."""
from __future__ import annotations

import importlib.util
import shutil
import sys
from pathlib import Path

MODULE = Path(__file__).resolve().parents[1] / "scripts/bin/research_writer_package_arxiv.py"
spec = importlib.util.spec_from_file_location("package_arxiv_tested", MODULE)
pkg = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = pkg
spec.loader.exec_module(pkg)


def _paper(root: Path, body: str) -> Path:
    root.mkdir()
    (root / "main.tex").write_text("\\documentclass{article}\n\\begin{document}\n" + body + "\n\\end{document}\n")
    return root


def test_inline_bbl_preserves_same_line_prose_and_comments(tmp_path):
    source = _paper(tmp_path / "source", "% \\bibliography{example}\nScientific result. \\bibliography{refs} Further discussion.")
    (source / "main.bbl").write_text("\\begin{thebibliography}{1}\\bibitem{x}X.\\end{thebibliography}\n")
    before = (source / "main.tex").read_bytes()
    out = tmp_path / "out"
    result, fatal = pkg.package(source, out, main_tex_override=None, force=False)
    assert fatal is None and result.ok
    text = (out / "main.tex").read_text()
    assert "% \\bibliography{example}" in text
    assert "Scientific result." in text and "Further discussion." in text
    assert text.count("\\begin{thebibliography}") == 1
    assert (source / "main.tex").read_bytes() == before


def test_existing_inline_bibliography_is_not_appended_again(tmp_path):
    body = "\\begin{thebibliography}{1}\\bibitem{x}X.\\end{thebibliography}"
    source = _paper(tmp_path / "source", body)
    (source / "main.bbl").write_text(body)
    result, fatal = pkg.package(source, tmp_path / "out", main_tex_override=None, force=False)
    assert fatal is None and result.ok
    assert (tmp_path / "out/main.tex").read_bytes() == (source / "main.tex").read_bytes()


def test_missing_or_external_graphic_is_not_portable_success(tmp_path):
    source = _paper(tmp_path / "source", "\\includegraphics{missing.pdf}\n\\includegraphics{../outside.pdf}")
    (tmp_path / "outside.pdf").write_bytes(b"synthetic graphics bytes")
    result, fatal = pkg.package(source, tmp_path / "out", main_tex_override=None, force=False)
    assert fatal is None and not result.ok
    assert any("missing" in defect for defect in result.defects)
    assert any("escapes" in defect for defect in result.defects)


def test_internal_symlink_becomes_bytes_and_survives_move(tmp_path):
    source = _paper(tmp_path / "source", "\\includegraphics{figure.pdf}")
    (source / "data.pdf").write_bytes(b"synthetic graphics bytes")
    (source / "figure.pdf").symlink_to("data.pdf")
    result, fatal = pkg.package(source, tmp_path / "out", main_tex_override=None, force=False)
    assert fatal is None and result.ok
    moved = tmp_path / "new-root/paper"
    moved.parent.mkdir()
    shutil.move(str(tmp_path / "out"), moved)
    shutil.rmtree(source)
    assert not (moved / "figure.pdf").is_symlink()
    assert (moved / "figure.pdf").read_bytes() == b"synthetic graphics bytes"


def test_symlink_outside_build_directory_is_rejected(tmp_path):
    source = _paper(tmp_path / "source", "\\includegraphics{figure.pdf}")
    (tmp_path / "outside.pdf").write_bytes(b"outside bytes")
    (source / "figure.pdf").symlink_to("../outside.pdf")
    result, fatal = pkg.package(source, tmp_path / "out", main_tex_override=None, force=False)
    assert fatal is None and not result.ok
    assert any("escapes" in defect for defect in result.defects)


def test_force_cannot_delete_build_tree_via_parent_destination(tmp_path):
    source = _paper(tmp_path / "source", "Scientific text.")
    before = (source / "main.tex").read_bytes()
    result, fatal = pkg.package(source, tmp_path, main_tex_override=None, force=True)
    assert fatal is not None
    assert (source / "main.tex").read_bytes() == before


def test_missing_bibliography_without_bbl_fails_and_preserves_old_bundle(tmp_path):
    source = _paper(tmp_path / "source", "\\cite{A}\\bibliography{missing}")
    output = tmp_path / "out"
    output.mkdir()
    (output / "previous_good.pdf").write_bytes(b"previous delivery")
    result, fatal = pkg.package(source, output, main_tex_override=None, force=True)
    assert fatal is None and not result.ok
    assert any("bibliography" in defect and "missing" in defect for defect in result.defects)
    assert (output / "previous_good.pdf").read_bytes() == b"previous delivery"


def test_successful_force_replaces_old_bundle_after_validation(tmp_path):
    source = _paper(tmp_path / "source", "Scientific text.")
    output = tmp_path / "out"
    output.mkdir()
    (output / "previous_good.pdf").write_bytes(b"previous delivery")
    result, fatal = pkg.package(source, output, main_tex_override=None, force=True)
    assert fatal is None and result.ok
    assert (output / "main.tex").read_bytes() == (source / "main.tex").read_bytes()
    assert not (output / "previous_good.pdf").exists()
